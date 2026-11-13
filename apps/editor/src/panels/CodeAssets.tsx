import { useEffect, useState } from 'react';
import type { CodePropValue } from '@bogen/core';
import { BookOpen, CodeXml, FolderCode, GitPullRequest, RefreshCw } from 'lucide-react';
import { session } from '../doc/session.ts';
import { codeComponents, importStories, linkCodeProject, measureCodeComponent, pullApi, useLinkedProject, type CodeComponentInfo, type LinkedProject, type PullDraft, type StoryImportReport } from '../lib/code-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { ui } from '../state/ui.ts';
import { insertAt, isContainer, pageId, visibleCentre } from '../ops/ops.ts';
import { editor } from '../state/store.ts';
import { IconButton } from '../ui/controls.tsx';
import '../styles/code.css';
import { useT } from '../i18n/react.ts';
import { msg } from '../i18n/core.ts';
import { t } from '../i18n/store.ts';

/** Props a new layer starts with: text for children, so that a button says something. */
function startProps(c: CodeComponentInfo): Record<string, CodePropValue> {
  const out: Record<string, CodePropValue> = {};
  for (const p of c.props) {
    if (p.name === 'children' && p.type === 'node') out.children = c.display;
    else if (p.required && p.type === 'string') out[p.name] = p.name[0]!.toUpperCase() + p.name.slice(1);
  }
  return out;
}

/** Components from the person's own repository, in the Assets panel: link a project folder, then click one to place it. */
export function CodeAssets({ query }: { query: string }) {
  const t = useT();
  const link = useLinkedProject();
  const [list, setList] = useState<CodeComponentInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);

  const load = (fresh = false) => {
    if (!link) return;
    setError(null);
    codeComponents(link.id, fresh).then(setList, (e: Error) => { setList(null); setError(e.message); });
  };
  useEffect(() => load(), [link?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await linkCodeProject(dir.trim(), session().fileId);
      setDir('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const place = async (c: CodeComponentInfo) => {
    if (!link) return;
    const s = session();
    const props = startProps(c);
    setBusy(true);
    try {
      const size = await measureCodeComponent(link.id, c.file, c.name, props).catch(() => ({ width: 320, height: 120 }));
      const selected = editor().selection.length === 1 ? s.snap.nodes.get(editor().selection[0]!) : undefined;
      const parent = selected && isContainer(selected) ? selected.id : pageId();
      const centre = visibleCentre();
      const id = insertAt(parent, {
        type: 'embed', name: c.display, style: { width: `${size.width}px`, height: `${size.height}px` },
        code: { project: link.id, file: c.file, name: c.name, import: c.import, props },
      }, { x: Math.round(centre.x - size.width / 2), y: Math.round(centre.y - size.height / 2) });
      editor().set({ selection: [id], tool: 'move' });
    } catch (e) {
      editor().showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const q = query.trim().toLowerCase();
  const shown = (list ?? []).filter((c) => !q || c.display.toLowerCase().includes(q) || c.file.toLowerCase().includes(q));
  return (
    <div className="asset-group code-assets" data-testid="code-assets">
      <div className="asset-group-title">
        <FolderCode size={13} />
        <span className="code-assets-name" title={link ? t('Components from this project, rendered by its own code in a sandbox') : undefined}>{link ? link.name : t('Code components')}</span>
        {link ? <IconButton icon={<RefreshCw size={12} />} title={t('Read the project again')} onClick={() => load(true)} testId="code-assets-refresh" /> : null}
      </div>
      {!link ? (
        <form className="code-assets-link" onSubmit={(e) => { e.preventDefault(); void connect(); }}>
          <input className="token-input" placeholder={t('Project folder, such as {example}', { example: '~/code/app' })} value={dir} onChange={(e) => setDir(e.target.value)} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} data-testid="code-link-dir" />
          <button type="submit" className="btn" disabled={busy || !dir.trim()} data-testid="code-link">{t('Link')}</button>
        </form>
      ) : null}
      {link && list && !shown.length ? <div className="hint">{list.length ? t('No component matches this search.') : t('No React components found in this project.')}</div> : null}
      {shown.map((c) => (
        <button key={`${c.file}#${c.name}`} type="button" className="code-asset" disabled={busy} title={t('{file}\nClick to place it in the middle of the view, or in the selected frame.', { file: c.file })} onClick={() => void place(c)} data-testid="code-asset" data-name={c.display}>
          <CodeXml size={13} className="ds-mark" />
          <span className="code-asset-name">{c.display}</span>
          <span className="code-asset-file">{c.file}</span>
        </button>
      ))}
      {error ? <div className="error" data-testid="code-assets-error">{error}</div> : null}
      {link ? <Stories link={link} /> : null}
      {link ? <PullRequests /> : null}
    </div>
  );
}

function storiesImported(): boolean {
  const v = session().doc.meta.get('storybook') as { project?: unknown } | undefined;
  return typeof v?.project === 'string';
}

/** Storybook stories as variant sets of code components. Once imported, the server keeps them in step. */
function Stories({ link }: { link: LinkedProject }) {
  const t = useT();
  const [report, setReport] = useState<StoryImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState(storiesImported);
  useEffect(() => {
    const meta = session().doc.meta;
    const update = () => setImported(storiesImported());
    meta.observe(update);
    return () => meta.unobserve(update);
  }, []);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await importStories(link.id, session().fileId);
      setReport(r);
      const stories = r.components.reduce((n, c) => n + c.stories.filter((st) => st.status !== 'removed').length, 0);
      if (r.components.length && editor().pageId !== r.page) editor().set({ pageId: r.page, selection: [] });
      editor().showToast(r.components.length ? storiesToast(r.components.length, stories, r.changed) : t('No story file with a component was found.'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sets = report?.components.length;
  return (
    <div className="code-sub" data-testid="code-stories">
      <div className="asset-group-title"><BookOpen size={13} /><span className="code-assets-name">Storybook</span></div>
      <div className="code-sub-row">
        <span className="hint code-sub-text">{report ? (imported ? t.n(sets ?? 0, '{count} set, on the Storybook page. Kept in step.', '{count} sets, on the Storybook page. Kept in step.') : t.n(sets ?? 0, '{count} set, on the Storybook page.', '{count} sets, on the Storybook page.')) : imported ? t('Imported. Kept in step while the file is open.') : t('Each story becomes a variant of a code component, with its args as props.')}</span>
        <button type="button" className="btn code-sub-btn" disabled={busy} onClick={() => void run()} data-testid="code-stories-import">{busy ? t('Reading') : imported ? t('Import again') : t('Import stories')}</button>
      </div>
      {report?.problems.map((p) => <div key={p.file} className="error code-sub-problem" title={p.problem} data-testid="code-stories-problem">{p.file.split('/').at(-1)}: {p.problem}</div>)}
      {error ? <div className="error">{error}</div> : null}
    </div>
  );
}

const STATUS_WORDS: Record<PullDraft['status'], string> = { running: msg('working'), ready: msg('ready to push'), opening: msg('pushing'), opened: msg('opened'), merged: msg('merged'), failed: msg('failed') };

/** The toast after an import: sets and stories, each counted in its own words. */
function storiesToast(sets: number, stories: number, changed: boolean): string {
  if (stories === 1) {
    return changed
      ? t.n(sets, '{count} set, {stories} story on the Storybook page.', '{count} sets, {stories} story on the Storybook page.', { stories })
      : t.n(sets, '{count} set, {stories} story on the Storybook page, as they were.', '{count} sets, {stories} story on the Storybook page, as they were.', { stories });
  }
  return changed
    ? t.n(sets, '{count} set, {stories} stories on the Storybook page.', '{count} sets, {stories} stories on the Storybook page.', { stories })
    : t.n(sets, '{count} set, {stories} stories on the Storybook page, as they were.', '{count} sets, {stories} stories on the Storybook page, as they were.', { stories });
}

/** This file's pull request drafts, so that one waits here after its dialog is closed. */
function PullRequests() {
  const t = useT();
  const [drafts, setDrafts] = useState<PullDraft[]>([]);
  const fileId = session().fileId;
  useEffect(() => {
    let live = true;
    const load = () => pullApi.list(fileId).then((a) => { if (live) setDrafts(a.drafts); }, () => {});
    void load();
    const off = onServerEvent((e) => { if (e.t === 'pull' && e.fileId === fileId) void load(); });
    return () => {
      live = false;
      off();
    };
  }, [fileId]);
  if (!drafts.length) return null;
  return (
    <div className="code-sub" data-testid="code-pulls">
      <div className="asset-group-title"><GitPullRequest size={13} /><span className="code-assets-name">{t('Pull requests')}</span></div>
      {drafts.map((d) => (
        <button key={d.id} type="button" className="code-asset" onClick={() => ui().set({ pull: { draft: d.id } })} title={d.what} data-testid="code-pull" data-status={d.status}>
          <span className={`code-pull-dot is-${d.status}`} />
          <span className="code-asset-name code-pull-title">{d.title}</span>
          <span className="code-asset-file">{d.status === 'running' && d.runner ? t('{name} is working', { name: d.runner }) : t(STATUS_WORDS[d.status])}</span>
        </button>
      ))}
    </div>
  );
}
