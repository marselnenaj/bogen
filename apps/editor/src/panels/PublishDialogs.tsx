import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useSnapVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { onServerEvent } from '../lib/events.ts';
import { useEditor, editor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { copyText, IconButton, Segmented } from '../ui/controls.tsx';
import { formatDate, formatDateTime } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { ClientRunBar } from './ChatExtras.tsx';
import '../styles/publish.css';

/**
 * The Publish and Share for review dialogs. They are the owner's side of publishing: an agent can only prepare a
 * version and ask, and the server takes the steps that make something reachable (publishing, a listener or Funnel
 * on, a review link, accepting a client's comment) only from this editor. What a client wrote is shown as text,
 * never as markup, and reaches the file only through Accept.
 */

type Target = 'listener' | 'folder' | 'github';
interface Version { id: string; n: number; at: number; by: string; files: number; bytes: number; notes: string[]; pages: { file: string; title: string; rootId: string }[] }
interface Site {
  id: string; fileId: string; pageId: string; nodeId?: string; name: string; versions: Version[];
  live: { listener?: string; folder?: { path: string; version: string }; github?: { repo: string; branch: string; version: string } };
}
interface Request { id: string; kind: 'publish' | 'share'; siteId: string; versionId: string; by: string; at: number; target?: Target; share?: { label: string; days: number; maxViews?: number; comments: boolean }; note?: string }
interface Share { id: string; siteId: string; versionId: string; label: string; createdAt: number; expiresAt: number; maxViews?: number; views: number; comments: boolean; state: 'active' | 'expired' | 'revoked' | 'used up' }
interface ClientComment { id: string; shareId: string; siteId: string; versionId: string; page: number; name: string; text: string; x?: number; y?: number; at: number; mentionsRemoved: boolean }
interface Listener { kind: string; on: boolean; public: boolean; listening: boolean; httpsPort: number; url: string | null; serve: 'ours' | 'free' | 'taken' | 'unknown'; funnel: boolean; funnelAllowed: boolean | null }
interface Overview { sites: Site[]; requests: Request[]; shares: Share[]; inbox: ClientComment[]; listeners: { site: Listener; review: Listener }; funnelPolicy: string[] }
interface CheckFinding { level: 'error' | 'warning' | 'note'; check: string; page?: string; path?: string; message: string; fix?: string }
type Skipped = { skipped: string };
interface PublishCheck {
  ok: boolean; counts: { errors: number; warnings: number; notes: number }; findings: CheckFinding[];
  summaries: {
    a11y?: { issues: number; errors: number; top: string[] } | Skipped;
    responsive?: { ok: boolean; widths: { width: number; overflow: number; clipped_text: number }[] } | Skipped;
    brand?: { brand: string; score: number; hard: number; soft: number } | Skipped;
  };
}
interface Plan { exists: boolean; upload: { path: string; bytes: number }[]; unchanged: string[]; remove: string[]; foreign: string[]; blocked: string[]; fingerprint: string; pagesUrl: string }

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? t('{method} {path} failed with {status}', { method, path, status: res.status }));
  return data;
}

const kb = (bytes: number) => (bytes < 1024 ? t('{bytes} B', { bytes }) : t('{kilobytes} KB', { kilobytes: Math.max(1, Math.round(bytes / 1024)) }));
const when = (at: number) => formatDateTime(at, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const day = (at: number) => formatDate(at, { day: 'numeric', month: 'short' });

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return t('just now');
  if (s < 3600) return t.n(Math.round(s / 60), '{count} min ago', '{count} min ago');
  if (s < 86400) return t.n(Math.round(s / 3600), '{count} h ago', '{count} h ago');
  return t.n(Math.round(s / 86400), '{count} d ago', '{count} d ago');
}

/** Everything about publishing for the open file, kept fresh by the server's `publish` event. */
function useOverview(fileId: string | null): { data: Overview | null; reload: () => void } {
  const [data, setData] = useState<Overview | null>(null);
  const reload = useCallback(() => {
    if (fileId) void call<Overview>('GET', `/api/publish?fileId=${encodeURIComponent(fileId)}`).then(setData, () => setData(null));
  }, [fileId]);
  useEffect(() => {
    reload();
    return onServerEvent((e) => { if (e.t === 'publish') reload(); });
  }, [reload]);
  return { data, reload };
}

/** What would be published: the one selected top-level layer, or the page. */
function useTarget(): { pageId: string | null; name: string; artboard: { id: string; name: string } | null } {
  const selection = useEditor((s) => s.selection);
  const pageId = useEditor((s) => s.pageId);
  useSnapVersion();
  const { snap } = session();
  const top = pageId && selection.length === 1 && snap.children(pageId).includes(selection[0]!) ? selection[0]! : null;
  const artboard = top ? { id: top, name: snap.nodes.get(top)?.name || t('Artboard') } : null;
  return { pageId, name: snap.pages.find((p) => p.id === pageId)?.name || t('Page'), artboard };
}

function Dialog({ title, subtitle, testId, onClose, children, footer }: { title: string; subtitle: string; testId: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button, input')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    const toRestore = back.current;
    return () => {
      window.removeEventListener('keydown', key, true);
      if (toRestore instanceof HTMLElement && toRestore.isConnected) toRestore.focus();
    };
  }, [onClose]);
  return (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} className="dialog publish" role="dialog" aria-modal="true" aria-label={title} data-testid={testId}>
        <header className="dialog-head settings-head">
          <span><span className="settings-title">{title}</span> <span className="publish-sub" dir="auto">{subtitle}</span></span>
          <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={onClose} testId={`${testId}-close`} />
        </header>
        <div className="publish-body">{children}</div>
        {footer ? <footer className="publish-foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="publish-row"><span className="publish-label">{label}</span><div className="publish-field">{children}</div></div>;
}

/**
 * A static listener: on or off, and on the tailnet or the internet. Funnel asks first, with what it means, and
 * says what the tailnet policy needs when Tailscale has not given this computer the funnel attribute.
 */
function ListenerControl({ which, state, policy, onChanged, testId }: { which: 'site' | 'review'; state: Listener; policy: string[]; onChanged: () => void; testId: string }) {
  const t = useT();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (body: { on: boolean; public?: boolean }) => {
    setBusy(true);
    void call<{ outcome: { state: string; message: string } | null }>('POST', `/api/publish/listeners/${which}`, body).then((r) => {
      if (r.outcome && !['added', 'removed', 'present', 'absent'].includes(r.outcome.state)) editor().showToast(r.outcome.message);
      setAsking(false);
      onChanged();
    }, (e: Error) => editor().showToast(e.message)).finally(() => setBusy(false));
  };
  return (
    <div className="publish-listener" data-testid={testId}>
      <div className="publish-line">
        <span className={`sync-dot${state.on && state.listening && state.serve === 'ours' ? ' is-on' : ''}`} />
        <span>{!state.on ? t('Off') : state.public ? t('Public on the internet') : t('On the tailnet only')}</span>
        {state.on && state.url ? <span className="hint publish-url">{state.url}</span> : null}
        <span className="publish-grow" />
        {state.on
          ? <button type="button" className="run-link" disabled={busy} onClick={() => set({ on: false })} data-testid={`${testId}-off`}>{t('Turn off')}</button>
          : <button type="button" className="run-link" disabled={busy} onClick={() => set({ on: true, public: false })} data-testid={`${testId}-on`}>{t('Turn on, tailnet only')}</button>}
      </div>
      {state.on && state.serve === 'taken' ? <div className="error">{t('Another app uses HTTPS port {port} in tailscale serve. Bogen leaves it alone.', { port: state.httpsPort })}</div> : null}
      {state.on && state.serve === 'free' ? <div className="error">{t('tailscale serve has nothing on HTTPS port {port} yet. Is Tailscale up?', { port: state.httpsPort })}</div> : null}
      {state.on ? (
        <label className="publish-check">
          <input type="checkbox" checked={state.public || asking} disabled={busy} data-testid={`${testId}-funnel`} onChange={(e) => (e.target.checked ? setAsking(true) : state.public ? set({ on: true, public: false }) : setAsking(false))} />
          {t('Public on the internet (Funnel)')}
        </label>
      ) : null}
      {asking && !state.public ? (
        <div className="publish-warn" role="alert" data-testid={`${testId}-funnel-warning`}>
          <b>{which === 'site' ? t('Anyone who has the address can open this site') : t('Anyone who has the address can open a link that still works')}</b>
          <span>{t('Funnel puts HTTPS port {port} of this computer on the internet. Visitors do not need Tailscale, and Bogen cannot tell who they are.', { port: state.httpsPort })}</span>
          <span>{which === 'site' ? t("Their traffic passes through Tailscale's relay servers on its way here. Only the published files answer: no editor, no API, nothing else of Bogen.") : t("Their traffic passes through Tailscale's relay servers on its way here. Only the review links answer: no editor, no API, nothing else of Bogen.")}</span>
          <span>{t('Every other tailscale serve or Funnel entry stays as it is. Turn it off here at any time.')}</span>
          {state.funnelAllowed === false ? (
            <span className="error">{t.rich('Your tailnet policy does not let this computer use Funnel. Its admin adds, in the Tailscale admin console: {policy} {detail}', { policy: <code>{policy[0]}</code>, detail: policy[1] })}</span>
          ) : null}
          <div className="publish-actions">
            <button type="button" className="btn" onClick={() => setAsking(false)}>{t('Keep it on the tailnet')}</button>
            <button type="button" className="btn publish-danger" disabled={busy || state.funnelAllowed === false} onClick={() => set({ on: true, public: true })} data-testid={`${testId}-funnel-confirm`}>{t('Make it public')}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function PublishDialogs() {
  const open = useUi((s) => s.publishDialog);
  const fileId = useEditor((s) => s.fileId);
  if (!open || !fileId) return null;
  return open === 'publish' ? <PublishDialog fileId={fileId} /> : <ShareDialog fileId={fileId} />;
}

function siteFor(data: Overview | null, pageId: string | null, nodeId: string | null): Site | undefined {
  return data?.sites.find((s) => s.pageId === pageId && (s.nodeId ?? null) === nodeId);
}

function PublishDialog({ fileId }: { fileId: string }) {
  const t = useT();
  const close = useCallback(() => ui().set({ publishDialog: null }), []);
  const { data, reload } = useOverview(fileId);
  const target = useTarget();
  const [whole, setWhole] = useState(!target.artboard);
  const nodeId = whole ? null : target.artboard?.id ?? null;
  const site = siteFor(data, target.pageId, nodeId);
  const request = data?.requests.find((r) => r.kind === 'publish' && r.siteId === site?.id);
  const [versionId, setVersionId] = useState<string | null>(null);
  const version = site?.versions.find((v) => v.id === versionId) ?? site?.versions.find((v) => v.id === request?.versionId) ?? site?.versions.at(-1);
  const [where, setWhere] = useState<Target | null>(null);
  const to: Target = where ?? request?.target ?? (site?.live.folder && !site.live.listener ? 'folder' : site?.live.github && !site.live.listener ? 'github' : 'listener');
  const [folder, setFolder] = useState<string | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [beside, setBeside] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<{ path: string; bytes: number }[] | null>(null);
  const [taking, setTaking] = useState(false);
  const check = usePublishCheck(fileId, target.pageId, nodeId, version?.id ?? null);
  const flagged = check.result ? check.result.counts.errors + check.result.counts.warnings : 0;
  const folderPath = folder ?? site?.live.folder?.path ?? `~/Sites/${(site?.name ?? target.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site'}`;
  const repoName = repo ?? site?.live.github?.repo ?? '';
  const branchName = branch ?? site?.live.github?.branch ?? 'gh-pages';

  useEffect(() => {
    setFiles(null);
    if (version) void call<{ path: string; bytes: number }[]>('GET', `/api/publish/versions/${version.id}/files`).then(setFiles, () => setFiles(null));
  }, [version?.id]);
  useEffect(() => {
    setPlan(null);
    setBeside(false);
    setError(null);
  }, [version?.id, to, repoName, branchName, folderPath]);

  const fail = (e: Error) => setError(e.message);
  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void fn().then(() => reload(), fail).finally(() => setBusy(false));
  };
  const prepare = () => run(async () => {
    const made = await call<{ version: Version }>('POST', '/api/publish/prepare', { fileId, pageId: target.pageId, ...(nodeId ? { nodeId } : {}) });
    setVersionId(made.version.id);
  });
  const showPlan = () => run(async () => {
    if (!site) return;
    setPlan(await call<Plan>('POST', `/api/publish/sites/${site.id}/github-plan`, { version: version?.id ?? null, repo: repoName.trim(), branch: branchName.trim() }));
  });
  const publish = () => run(async () => {
    if (!site || !version) return;
    if (to === 'listener' && !data?.listeners.site.on) await call('POST', '/api/publish/listeners/site', { on: true, public: false });
    const body = to === 'listener' ? {} : to === 'folder' ? { path: folderPath.trim(), allowForeign: beside } : { repo: repoName.trim(), branch: branchName.trim(), fingerprint: plan?.fingerprint, allowForeign: beside };
    await call('POST', `/api/publish/sites/${site.id}/publish`, { version: version.id, target: to, ...body, ...(request ? { requestId: request.id } : {}) });
    editor().showToast(to === 'listener' ? t("v{version} is published on Bogen's site.", { version: version.n }) : to === 'folder' ? t('v{version} is published in {folder}.', { version: version.n, folder: folderPath }) : t('v{version} is published to {repo}.', { version: version.n, repo: repoName }));
    setPlan(null);
  });
  const unpublish = () => run(async () => {
    if (!site) return;
    await call('POST', `/api/publish/sites/${site.id}/unpublish`, { target: to });
    setTaking(false);
  });

  const liveHere = site ? (to === 'listener' ? site.live.listener : to === 'folder' ? site.live.folder?.version : site.live.github?.version) : undefined;
  const needsPlan = to === 'github' && (!plan || plan.blocked.length > 0);
  const needsBeside = (to === 'github' && (plan?.foreign.length ?? 0) > 0) || (to === 'folder' && /did not write/.test(error ?? ''));
  const ready = Boolean(site && version) && !busy && !needsPlan && (!needsBeside || beside) && (to !== 'folder' || folderPath.trim()) && (to !== 'github' || repoName.trim());

  return (
    <Dialog
      title={t('Publish')} subtitle={nodeId ? target.artboard!.name : t('{page}, whole page', { page: target.name })} testId="publish-dialog" onClose={close}
      footer={(
        <>
          {liveHere ? (taking
            ? <button type="button" className="btn publish-danger" disabled={busy} onClick={unpublish} data-testid="publish-unpublish-confirm">{to === 'listener' ? t('Take it down from Bogen site') : to === 'folder' ? t('Take it down from the folder') : t('Take it down from GitHub')}</button>
            : <button type="button" className="btn btn-quiet publish-danger-text" onClick={() => setTaking(true)} data-testid="publish-unpublish">{t('Unpublish')}</button>) : null}
          <span className="publish-grow" />
          <button type="button" className="btn" onClick={close}>{t('Cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={!ready} onClick={publish} data-testid="publish-run">{version ? (flagged ? t('Publish v{version} anyway', { version: version.n }) : liveHere === version.id ? t('Publish v{version} again', { version: version.n }) : t('Publish v{version}', { version: version.n })) : t('Publish')}</button>
        </>
      )}
    >
      <Field label={t('What')}>
        <div className="publish-line">
          <Segmented<'board' | 'page'> value={whole ? 'page' : 'board'} onChange={(v) => setWhole(v === 'page')} testId="publish-what" options={[{ value: 'board', label: t('This artboard'), title: target.artboard ? target.artboard.name : t('Select one artboard first'), disabled: !target.artboard }, { value: 'page', label: t('Whole page'), title: t('One HTML file per artboard') }]} />
          <span className="hint">{t('Static HTML and CSS, @media read from the window. No script.')}</span>
        </div>
      </Field>
      <Field label={t('Where')}>
        <div className="publish-choices" role="radiogroup">
          <Choice on={to === 'listener'} onPick={() => setWhere('listener')} name={t('Bogen site')} note={data?.listeners.site.url ?? t('on this computer, through Tailscale')} testId="publish-to-listener">
            {to === 'listener' && data ? <ListenerControl which="site" state={data.listeners.site} policy={data.funnelPolicy} onChanged={reload} testId="publish-listener" /> : null}
            {to === 'listener' ? <span className="hint">{t('One site at a time: publishing here takes the place of what is there now.')}</span> : null}
          </Choice>
          <Choice on={to === 'folder'} onPick={() => setWhere('folder')} name={t('A folder')} note={site?.live.folder?.path ?? t('on this computer')} testId="publish-to-folder">
            {to === 'folder' ? (
              <>
                <input className="publish-input" value={folderPath} onChange={(e) => setFolder(e.target.value)} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} data-testid="publish-folder" aria-label={t('Folder')} />
                <span className="hint">{t('Only files Bogen wrote there are replaced or removed. A folder with other files needs your yes.')}</span>
              </>
            ) : null}
          </Choice>
          <Choice on={to === 'github'} onPick={() => setWhere('github')} name="GitHub Pages" note={site?.live.github ? `${site.live.github.repo}, ${site.live.github.branch}` : t('through your own gh')} testId="publish-to-github">
            {to === 'github' ? (
              <>
                <div className="publish-line">
                  <input className="publish-input" placeholder={t('owner/repository')} value={repoName} onChange={(e) => setRepo(e.target.value)} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} data-testid="publish-repo" aria-label={t('Repository')} />
                  <input className="publish-input publish-branch" value={branchName} onChange={(e) => setBranch(e.target.value)} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} data-testid="publish-branch" aria-label={t('Branch')} />
                  <button type="button" className="btn" disabled={busy || !repoName.trim() || !version} onClick={showPlan} data-testid="publish-plan">{t('Show what gets pushed')}</button>
                </div>
                <span className="hint">{t('Through your own gh, as one commit. Bogen never sees a token.')}</span>
                {plan ? <PlanView plan={plan} repo={repoName} branch={branchName} /> : null}
              </>
            ) : null}
          </Choice>
        </div>
      </Field>
      <Field label={t('Files')}>
        {version ? (
          <div className="publish-files" data-testid="publish-files">
            {(files ?? []).slice(0, 12).map((f) => <div key={f.path} className="publish-file"><span>{f.path}</span><span className="hint">{kb(f.bytes)}</span></div>)}
            {files && files.length > 12 ? <div className="hint">{t.n(files.length - 12, 'and {count} more', 'and {count} more')}</div> : null}
            <div className="publish-file publish-sum"><span className="hint">{t.n(version.files, '{count} file, {size}. No script, no layer ids, no comments.', '{count} files, {size}. No script, no layer ids, no comments.', { size: kb(version.bytes) })}</span><span className="hint">v{version.n}</span></div>
            {version.notes.map((n) => <div key={n} className="hint">{n}</div>)}
          </div>
        ) : <span className="hint">{t('No version yet. A version is a frozen copy of the design as it is now.')}</span>}
      </Field>
      <Field label={t('Check')}>
        <CheckView state={check} artboard={nodeId ? target.artboard?.name ?? null : null} page={target.name} />
      </Field>
      <Field label={t('Versions')}>
        <div className="publish-list" data-testid="publish-versions">
          <div className="publish-item"><span className="hint">{t('The design as it is now')}</span><span className="publish-grow" /><button type="button" className="run-link" disabled={busy || !target.pageId} onClick={prepare} data-testid="publish-prepare">{t('Make a version')}</button></div>
          {[...(site?.versions ?? [])].reverse().slice(0, 8).map((v) => {
            const places = [site!.live.listener === v.id ? t('Bogen site') : '', site!.live.folder?.version === v.id ? t('the folder') : '', site!.live.github?.version === v.id ? 'GitHub' : ''].filter(Boolean);
            const asked = request?.versionId === v.id;
            return (
              <button type="button" key={v.id} className={`publish-item${v.id === version?.id ? ' is-on' : ''}${asked ? ' is-asked' : ''}`} onClick={() => setVersionId(v.id)} data-testid="publish-version">
                <b>v{v.n}</b>
                <span>{asked ? (request!.note ? t('Prepared by {agent}, waits for you: {note}', { agent: request!.by, note: request!.note }) : t('Prepared by {agent}, waits for you', { agent: request!.by })) : places.length ? t('Live on {places}', { places: places.join(', ') }) : t('by {author}', { author: v.by })}</span>
                <span className="publish-grow" />
                <span className="hint">{when(v.at)}</span>
              </button>
            );
          })}
          {request ? <div className="publish-item"><span className="hint">{t('Not now?')}</span><span className="publish-grow" /><button type="button" className="run-link" onClick={() => run(() => call('DELETE', `/api/publish/requests/${request.id}`))} data-testid="publish-dismiss">{t("Dismiss {agent}'s request", { agent: request.by })}</button></div> : null}
        </div>
      </Field>
      {needsBeside ? (
        <label className="publish-check publish-row-indent">
          <input type="checkbox" checked={beside} onChange={(e) => setBeside(e.target.checked)} data-testid="publish-beside" />
          {to === 'github' ? t.n(plan!.foreign.length, 'Publish beside {count} file Bogen did not write. They stay as they are.', 'Publish beside {count} files Bogen did not write. They stay as they are.') : t('Publish beside files Bogen did not write. They stay as they are.')}
        </label>
      ) : null}
      {error ? <div className="error publish-row-indent" data-testid="publish-error">{error}</div> : null}
    </Dialog>
  );
}

/**
 * The check before publishing, on this computer: the version's files when there is one, else the design as it is now.
 * It only warns; the person publishes anyway when they want to.
 */
function usePublishCheck(fileId: string, pageId: string | null, nodeId: string | null, versionId: string | null): { result: PublishCheck | null; busy: boolean; error: string | null } {
  const [state, setState] = useState<{ key: string; result: PublishCheck | null; error: string | null }>({ key: '', result: null, error: null });
  const key = `${fileId}/${pageId}/${nodeId}/${versionId}`;
  useEffect(() => {
    if (!pageId) return;
    let live = true;
    const body = versionId ? { versionId } : { fileId, pageId, ...(nodeId ? { nodeId } : {}) };
    void call<PublishCheck>('POST', '/api/publish/check', body).then(
      (result) => { if (live) setState({ key, result, error: null }); },
      (e: Error) => { if (live) setState({ key, result: null, error: e.message }); },
    );
    return () => { live = false; };
  }, [key]);
  const current = state.key === key;
  return { result: current ? state.result : null, busy: !current, error: current ? state.error : null };
}

function CheckView({ state, artboard, page }: { state: ReturnType<typeof usePublishCheck>; artboard: string | null; page: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  if (state.error) return <span className="hint" data-testid="publish-check-error">{state.error}</span>;
  if (!state.result) return <span className="hint" data-testid="publish-check-busy">{t('Checking on this computer')}</span>;
  const { counts, findings, summaries } = state.result;
  const shown = findings.filter((f) => f.level !== 'note');
  const list = all ? shown : shown.slice(0, 6);
  const word = (level: CheckFinding['level']) => (level === 'error' ? t('Problem') : level === 'warning' ? t('Warning') : t('Note'));
  const a11y = summaries.a11y && 'issues' in summaries.a11y ? summaries.a11y : null;
  const responsive = summaries.responsive && 'widths' in summaries.responsive ? summaries.responsive : null;
  const brand = summaries.brand && 'score' in summaries.brand ? summaries.brand : null;
  const broken = responsive?.widths.filter((w) => w.overflow || w.clipped_text).map((w) => `${w.width}`) ?? [];
  const also = [
    a11y ? t.n(a11y.issues, 'Accessibility: {count} issue', 'Accessibility: {count} issues') : '',
    responsive ? (broken.length ? t('Responsive: breaks at {widths} px', { widths: broken.join(', ') }) : t('Responsive: fine')) : '',
    brand ? t('Brand: {score} of 100', { score: brand.score }) : '',
  ].filter(Boolean);
  const prompt = artboard ? t('Run publish_check on the artboard {name} and fix what it finds.', { name: artboard }) : t('Run publish_check on the page {name} and fix what it finds.', { name: page });
  return (
    <div className="publish-checks" data-testid="publish-check" data-errors={counts.errors} data-warnings={counts.warnings}>
      <span className="publish-check-head" data-testid="publish-check-summary">
        {counts.errors || counts.warnings
          ? [counts.errors ? t.n(counts.errors, '{count} problem', '{count} problems') : '', counts.warnings ? t.n(counts.warnings, '{count} warning', '{count} warnings') : ''].filter(Boolean).join(', ')
          : t('Nothing to fix before publishing.')}
        {' '}<span className="hint">{t('Checked on this computer. Nothing was sent anywhere.')}</span>
      </span>
      {list.map((f, i) => (
        <div key={`${f.check}-${f.page ?? ''}-${f.path ?? ''}-${i}`} className={`publish-finding is-${f.level}`} data-testid="publish-check-finding" data-level={f.level} data-check={f.check}>
          <span className="publish-finding-level">{word(f.level)}</span>
          <span className="publish-finding-text" dir="auto">{f.page && f.page !== 'index.html' ? `${f.page}: ` : ''}{f.message}</span>
        </div>
      ))}
      {shown.length > list.length ? <button type="button" className="run-link publish-finding-more" onClick={() => setAll(true)}>{t.n(shown.length - list.length, 'and {count} more', 'and {count} more')}</button> : null}
      {also.length ? <div className="hint" data-testid="publish-check-also">{also.join(' · ')}</div> : null}
      {counts.errors || counts.warnings ? <button type="button" className="run-link publish-finding-more" onClick={() => void copyText(prompt).then(() => editor().showToast(t('Copied. Paste it to your agent.')))} data-testid="publish-check-copy">{t('Copy for your agent')}</button> : null}
    </div>
  );
}

function Choice({ on, onPick, name, note, testId, children }: { on: boolean; onPick: () => void; name: string; note: string; testId: string; children?: ReactNode }) {
  return (
    <div className={`publish-choice${on ? ' is-on' : ''}`}>
      <button type="button" role="radio" aria-checked={on} className="publish-choice-head" onClick={onPick} data-testid={testId}>
        <span className="publish-radio" /><b>{name}</b><span className="hint">{note}</span>
      </button>
      {on && children ? <div className="publish-choice-body">{children}</div> : null}
    </div>
  );
}

function PlanView({ plan, repo, branch }: { plan: Plan; repo: string; branch: string }) {
  const t = useT();
  return (
    <div className="publish-plan" data-testid="publish-github-plan">
      <div className="publish-line"><b>{t('What gets pushed')}</b><span className="hint">{plan.exists ? t('{repo}, {branch}, one commit', { repo, branch }) : t('{repo}, {branch} (a new branch), one commit', { repo, branch })}</span></div>
      {plan.upload.map((f) => <div key={f.path} className="publish-file"><span>{f.path}</span><span className="hint">{kb(f.bytes)}</span></div>)}
      {plan.remove.map((p) => <div key={p} className="publish-file"><span>{p}</span><span className="hint">{t('removed, from an earlier publish')}</span></div>)}
      {plan.unchanged.length ? <div className="hint">{t.n(plan.unchanged.length, '{count} file already there as they are.', '{count} files already there as they are.')}</div> : null}
      {!plan.upload.length && !plan.remove.length ? <div className="hint">{t('Nothing changes.')}</div> : null}
      {plan.foreign.length ? <div className="publish-file publish-sum"><span>{plan.foreign.slice(0, 4).join(', ')}{plan.foreign.length > 4 ? ', ...' : ''}</span><span className="hint">{t("not Bogen's, stay as they are")}</span></div> : null}
      {plan.blocked.length ? <div className="error">{t.n(plan.blocked.length, 'Nothing can be pushed: {files} is on the branch and Bogen did not write it.', 'Nothing can be pushed: {files} are on the branch and Bogen did not write them.', { files: plan.blocked.slice(0, 4).join(', ') })}</div> : null}
      <div className="hint">{t('Will be at {url} once Pages serves this branch.', { url: plan.pagesUrl })}</div>
    </div>
  );
}

function ShareDialog({ fileId }: { fileId: string }) {
  const t = useT();
  const close = useCallback(() => ui().set({ publishDialog: null }), []);
  const { data, reload } = useOverview(fileId);
  const target = useTarget();
  const nodeId = target.artboard?.id ?? null;
  const site = siteFor(data, target.pageId, nodeId);
  const newest = site?.versions.at(-1);
  const [fresh, setFresh] = useState(false);
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(14);
  const [views, setViews] = useState(0);
  const [comments, setComments] = useState(true);
  const [made, setMade] = useState<{ url: string | null; label: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Client comments picked to go to one revision run together.
  const [picked, setPicked] = useState<string[]>([]);
  const sites = useMemo(() => new Map((data?.sites ?? []).map((s) => [s.id, s])), [data]);
  const vn = (siteId: string, versionId: string) => sites.get(siteId)?.versions.find((v) => v.id === versionId)?.n;
  const shareLabel = (id: string) => data?.shares.find((s) => s.id === id)?.label ?? t('a link');

  const run = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void fn().then(() => reload(), (e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const create = (input: { siteId?: string; versionId?: string; label: string; days: number; maxViews?: number; comments: boolean; requestId?: string }) => run(async () => {
    let siteId = input.siteId;
    let versionId = input.versionId;
    if (!siteId || !versionId) {
      const prepared = await call<{ site: Site; version: Version }>('POST', '/api/publish/prepare', { fileId, pageId: target.pageId, ...(nodeId ? { nodeId } : {}) });
      siteId = prepared.site.id;
      versionId = prepared.version.id;
    }
    const answer = await call<{ url: string | null; note: string; share: Share }>('POST', '/api/shares', { siteId, versionId, label: input.label || 'Review link', days: input.days, ...(input.maxViews ? { maxViews: input.maxViews } : {}), comments: input.comments, ...(input.requestId ? { requestId: input.requestId } : {}) });
    setMade({ url: answer.url, label: answer.share.label, note: answer.note });
    setLabel('');
  });
  const review = data?.listeners.review;
  const requests = data?.requests.filter((r) => r.kind === 'share') ?? [];

  return (
    <Dialog title={t('Share for review')} subtitle={target.artboard ? target.artboard.name : t('{page}, whole page', { page: target.name })} testId="share-dialog" onClose={close}>
      <div className="publish-box" data-testid="share-new">
        <div className="publish-line">
          <b>{t('New link')}</b>
          <span className="hint">{fresh || !newest ? t('of a new version, frozen') : t('of v{version}, frozen', { version: newest.n })}</span>
          <span className="publish-grow" />
          {newest ? <label className="publish-check"><input type="checkbox" checked={fresh} onChange={(e) => setFresh(e.target.checked)} data-testid="share-fresh" />{t('Make a new version first')}</label> : null}
        </div>
        <div className="publish-line">
          <input className="publish-input" placeholder={t('Who it is for, such as Anna at Couchette')} dir="auto" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="share-label" aria-label={t('Who it is for')} />
          <label className="publish-small">{t('Days')}<input className="publish-input publish-num" type="number" min={1} max={90} value={days} onChange={(e) => setDays(Math.min(90, Math.max(1, Math.round(Number(e.target.value) || 14))))} onKeyDown={(e) => e.stopPropagation()} data-testid="share-days" /></label>
          <label className="publish-small">{t('Views')}<input className="publish-input publish-num" type="number" min={0} max={100000} value={views || ''} placeholder={t('no limit')} onChange={(e) => setViews(Math.max(0, Math.round(Number(e.target.value) || 0)))} onKeyDown={(e) => e.stopPropagation()} data-testid="share-views" /></label>
        </div>
        <label className="publish-check"><input type="checkbox" checked={comments} onChange={(e) => setComments(e.target.checked)} data-testid="share-comments" />{t('Clients may comment')}<span className="hint">{t('Their comments wait in the inbox below and never reach an agent.')}</span></label>
        {review ? <ListenerControl which="review" state={review} policy={data!.funnelPolicy} onChanged={reload} testId="share-listener" /> : null}
        <div className="publish-line">
          <span className="hint">{review?.on ? (review.public ? t('Anyone with the link can open it.') : t('Only people on your tailnet can open it.')) : t('Links open once the review listener is on.')}</span>
          <span className="publish-grow" />
          <button type="button" className="btn btn-primary" disabled={busy || !target.pageId} onClick={() => create({ ...(fresh || !newest ? {} : { siteId: site!.id, versionId: newest.id }), label: label.trim(), days, ...(views ? { maxViews: views } : {}), comments })} data-testid="share-create">{t('Create link')}</button>
        </div>
      </div>
      {error ? <div className="error" data-testid="share-error">{error}</div> : null}

      <div className="publish-list" data-testid="share-links">
        {made ? (
          <div className="publish-item is-asked" data-testid="share-made">
            <b dir="auto">{made.label}</b>
            {made.url ? <span className="publish-url" data-testid="share-url">{made.url}</span> : <span className="hint">{made.note}</span>}
            <span className="publish-grow" />
            {made.url ? <button type="button" className="run-link" onClick={() => void copyText(made.url!).then(() => editor().showToast(t('Copied. Bogen keeps no copy of this link.')))} data-testid="share-copy">{t('Copy')}</button> : null}
            <span className="hint">{t('Shown once')}</span>
          </div>
        ) : null}
        {requests.map((r) => (
          <div key={r.id} className="publish-item is-asked" data-testid="share-request">
            <b>{t('Prepared by {agent}', { agent: r.by })}</b>
            <span className="hint" dir="auto">{[t('{site} v{version}', { site: sites.get(r.siteId)?.name ?? '', version: vn(r.siteId, r.versionId) ?? '' }), t.n(r.share?.days ?? 14, '{count} day', '{count} days'), r.share?.comments ? t('comments on') : t('no comments'), ...(r.share?.label ? [t('for {person}', { person: r.share.label })] : [])].join(', ')}</span>
            <span className="publish-grow" />
            <button type="button" className="run-link" onClick={() => run(() => call('DELETE', `/api/publish/requests/${r.id}`))}>{t('Discard')}</button>
            <button type="button" className="run-link" disabled={busy} onClick={() => create({ siteId: r.siteId, versionId: r.versionId, label: r.share?.label ?? 'Review link', days: r.share?.days ?? 14, ...(r.share?.maxViews ? { maxViews: r.share.maxViews } : {}), comments: r.share?.comments ?? false, requestId: r.id })} data-testid="share-request-create">{t('Create this link')}</button>
          </div>
        ))}
        {(data?.shares ?? []).slice().reverse().map((s) => (
          <div key={s.id} className="publish-item" data-testid="share-link">
            <b dir="auto">{s.label}</b>
            <span className="hint" dir="auto">{[t('{site} v{version}', { site: sites.get(s.siteId)?.name ?? '', version: vn(s.siteId, s.versionId) ?? '' }), s.maxViews ? t.n(s.maxViews, '{views} of {count} view', '{views} of {count} views', { views: s.views }) : t.n(s.views, '{count} view', '{count} views'), s.state === 'active' ? t('until {date}', { date: day(s.expiresAt) }) : s.state === 'used up' ? t('used up') : s.state === 'revoked' ? t('revoked') : t('expired'), ...(s.comments ? [t('comments on')] : [])].join(', ')}</span>
            <span className="publish-grow" />
            {s.state === 'active' ? <button type="button" className="run-link publish-danger-text" onClick={() => run(() => call('DELETE', `/api/shares/${s.id}`))} data-testid="share-revoke">{t('Revoke')}</button> : <span className="hint">{s.state === 'used up' ? t('Used up') : s.state === 'revoked' ? t('Revoked') : t('Expired')}</span>}
          </div>
        ))}
        {!made && !requests.length && !data?.shares.length ? <div className="publish-item"><span className="hint">{t('No review links for this file yet.')}</span></div> : null}
      </div>

      <div className="publish-line publish-inbox-head"><b>{t('From clients')}</b><span className="hint">{data?.inbox.length ? t.n(data.inbox.length, '{count} waiting. Plain text, not in the file until you accept it.', '{count} waiting. Plain text, not in the file until you accept it.') : t('Nothing waiting.')}</span></div>
      {data?.inbox.length ? (
        <div className="publish-list" data-testid="client-inbox">
          {data.inbox.map((c) => (
            <div key={c.id} className="publish-comment" data-testid="client-comment">
              <div className="publish-line"><input type="checkbox" className="client-pick" checked={picked.includes(c.id)} onChange={(e) => setPicked((list) => (e.target.checked ? [...list, c.id] : list.filter((id) => id !== c.id)))} aria-label={t('Pick this comment for one run')} data-testid="client-comment-pick" /><span className="publish-tag">{t('from a client')}</span><b dir="auto">{c.name}</b><span className="hint" dir="auto">{[shareLabel(c.shareId), c.x !== undefined ? t('at {x}, {y}', { x: c.x, y: c.y ?? '' }) : t('no position'), ago(c.at)].join(', ')}</span></div>
              <div className="publish-text" dir="auto">{c.text}</div>
              <div className="publish-line">
                {c.mentionsRemoved ? <span className="hint">{t('The @ of a mention was taken out. Nothing starts an agent.')}</span> : null}
                <span className="publish-grow" />
                <button type="button" className="run-link" onClick={() => run(() => call('DELETE', `/api/shares/inbox/${c.id}`))} data-testid="client-comment-delete">{t('Delete')}</button>
                <button type="button" className="run-link" disabled={busy} onClick={() => run(() => call('POST', `/api/shares/inbox/${c.id}/accept`))} data-testid="client-comment-accept">{t('Accept as comment')}</button>
              </div>
            </div>
          ))}
          <ClientRunBar picked={picked.filter((id) => data.inbox.some((c) => c.id === id))} onSent={(ids) => { setPicked((list) => list.filter((id) => !ids.includes(id))); reload(); }} />
        </div>
      ) : null}
    </Dialog>
  );
}
