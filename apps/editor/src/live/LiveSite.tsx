import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, MousePointerClick, Square } from 'lucide-react';
import { agentApi, type LiveSiteInfo, type PickedElement, type RunRecord } from '../lib/agent-api.ts';
import { api, type Runner } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { RunChoice, runnerName, useRunSettings } from '../panels/RunChoice.tsx';
import { duration } from '../panels/RunHistory.tsx';
import { IconButton, SelectField } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';

/** What a run says, in order. */
interface Line { role: 'user' | 'agent' | 'tool' | 'error' | 'done'; text: string }

/**
 * The page lives on another origin, in a frame without access to this one. All it can do here is say what was picked.
 * That only fills in this panel: a run starts when the person presses send, with what they wrote.
 */
export function LiveSitePage({ siteId }: { siteId?: string }) {
  const t = useT();
  const [site, setSite] = useState<LiveSiteInfo | null>(null);
  const [url, setUrl] = useState('http://127.0.0.1:5173');
  const [dir, setDir] = useState('');
  const [recent, setRecent] = useState<{ url: string; dir: string; at: number }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [element, setElement] = useState<PickedElement | null>(null);
  const [prompt, setPrompt] = useState('');
  const [runners, setRunners] = useState<Runner[]>([]);
  const [runner, setRunner] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [history, setHistory] = useState<RunRecord[]>([]);
  const frame = useRef<HTMLIFrameElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const settings = useRunSettings();

  useEffect(() => {
    document.title = t('Live site - Bogen');
  }, [t]);

  useEffect(() => {
    void agentApi.liveSites().then(({ sites, recent: r }) => {
      setRecent(r);
      const found = sites.find((s) => s.id === siteId);
      if (found) setSite(found);
      else if (r[0]) {
        setUrl(r[0].url);
        setDir(r[0].dir);
      }
    }, () => {});
    void api.runners().then((list) => {
      setRunners(list);
      setRunner((r) => r || list.find((x) => x.available)?.id || '');
    }, () => {});
  }, [siteId]);

  useEffect(() => {
    if (!site) return;
    const origin = new URL(site.proxyUrl).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow || !e.data || typeof e.data !== 'object') return;
      const data = e.data as { bogenLive?: string; element?: PickedElement; picking?: boolean };
      if (data.bogenLive === 'pick' && data.element) setElement(data.element);
      else if (data.bogenLive === 'mode') setPicking(Boolean(data.picking));
      else if (data.bogenLive === 'ready' && picking) tellFrame(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [site, picking]);

  useEffect(() => {
    if (!site) return;
    const load = () => void agentApi.runs(site.historyKey).then(setHistory, () => {});
    load();
    return onServerEvent((e) => {
      if (e.t === 'run-history' && e.fileId === site.historyKey) load();
      if (e.t !== 'agent' || e.fileId !== site.historyKey) return;
      if (e.kind === 'text') setLines((l) => [...l, { role: 'agent', text: e.text ?? '' }]);
      else if (e.kind === 'tool') setLines((l) => [...l, { role: 'tool', text: e.tool ?? t('tool') }]);
      else if (e.kind === 'error') {
        setLines((l) => [...l, { role: 'error', text: e.text ?? t('The run failed.') }]);
        setRunId(null);
      } else {
        setLines((l) => [...l, { role: 'done', text: e.text ?? t('Done.') }]);
        setRunId(null);
      }
    });
  }, [site, t]);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [lines]);

  const tellFrame = (on: boolean) => {
    if (!site) return;
    frame.current?.contentWindow?.postMessage({ bogenLive: 'mode', picking: on }, new URL(site.proxyUrl).origin);
  };
  const togglePick = () => {
    const next = !picking;
    setPicking(next);
    tellFrame(next);
  };

  const open = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    try {
      const opened = await agentApi.openLive(url.trim(), dir.trim());
      setSite(opened);
      history.length = 0;
      location.hash = `#/live/${opened.id}`;
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const ask = async () => {
    const text = prompt.trim();
    if (!site || !text || !runner || runId) return;
    setPrompt('');
    setLines((l) => [...l, { role: 'user', text }]);
    const { model, effort } = settings?.settings.runners[runner]?.prompt ?? {};
    try {
      const { runId: id } = await agentApi.askLive(site.id, {
        prompt: text, runner, ...(element ? { element } : {}),
        ...(model && model !== 'default' ? { model } : {}), ...(effort && effort !== 'default' ? { effort } : {}),
      });
      setRunId(id);
    } catch (err) {
      setLines((l) => [...l, { role: 'error', text: (err as Error).message }]);
    }
  };

  if (!site) {
    return (
      <div className="live-start" data-testid="live-start">
        <a className="live-back" href="#/"><ArrowLeft size={13} /> {t('Files')}</a>
        <h1 className="live-title">{t('Open a live site')}</h1>
        <p className="hint">{t('Your dev server opens here with hot reload still working. Pick an element, and your own agent edits the source: only files in the project folder, with no shell.')}</p>
        <form className="live-form" onSubmit={(e) => void open(e)}>
          <label className="live-field"><span>{t('Dev server')}</span><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:5173" data-testid="live-url" spellCheck={false} /></label>
          <label className="live-field"><span>{t('Project folder')}</span><input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="/home/you/project" data-testid="live-dir" spellCheck={false} /></label>
          <button type="submit" className="btn btn-primary" disabled={!url.trim() || !dir.trim()} data-testid="live-open">{t('Open')}</button>
        </form>
        {error ? <div className="error" data-testid="live-error">{error}</div> : null}
        {recent.length ? (
          <div className="live-recent">
            {recent.map((r) => (
              <button key={`${r.url}${r.dir}`} type="button" className="feed-row" onClick={() => { setUrl(r.url); setDir(r.dir); }}>
                <span className="feed-agent">{r.url}</span><span className="feed-tool">{r.dir}</span><span />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  const running = runId !== null;
  return (
    <div className="live" data-testid="live">
      <div className="live-main">
        <div className="live-bar">
          <a className="live-back" href="#/" title={t('Back to your files')}><ArrowLeft size={13} /></a>
          <span className="live-target" title={site.dir}>{site.target}</span>
          <span className="hint live-dir" title={site.dir}>{site.dir}</span>
          <button type="button" className={`btn${picking ? ' btn-primary' : ' btn-quiet'}`} onClick={togglePick} data-testid="live-pick" title={t('Hover and click an element in the page. {key} stops.', { key: 'Esc' })}><MousePointerClick size={13} /> {picking ? t('Picking') : t('Pick element')}</button>
        </div>
        <iframe
          ref={frame}
          className="live-frame"
          src={site.proxyUrl}
          title={t('Your site')}
          data-testid="live-frame"
          // Its own origin for what the site needs, and nothing that reaches this page or moves it away.
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads"
          referrerPolicy="no-referrer"
        />
      </div>
      <aside className="panel live-side" data-testid="live-side">
        <div className="section-plain">
          <div className="feed-title">{t('Element')}</div>
          {!element ? <div className="hint">{t('Nothing picked. Without one, your agent works from what you write.')}</div> : (
            <div className="live-element" data-testid="live-element">
              <div className="live-selector">{element.selector}</div>
              <div className="hint" data-testid="live-source">{element.source?.file ? t('{file}, from {via}', { file: `${element.source.file}${element.source.line ? `:${element.source.line}` : ''}`, via: String(element.source.via) }) : t('This framework does not say which file it came from, so your agent will search.')}</div>
              <details className="live-details"><summary>{t('HTML and styles')}</summary><pre className="code"><code>{element.html}</code></pre><pre className="code"><code>{Object.entries(element.styles).map(([k, v]) => `${k}: ${v}`).join('\n')}</code></pre></details>
              <button type="button" className="run-link" onClick={() => setElement(null)}>{t('Clear')}</button>
            </div>
          )}
        </div>
        <div className="section-plain live-ask">
          <div ref={log} className="live-log" data-testid="live-log">
            {lines.map((l, i) => <div key={i} dir="auto" className={`prompt-msg is-${l.role === 'done' ? 'tool' : l.role}`}>{l.text}</div>)}
          </div>
          <div className="prompt-input-row">
            <textarea className="prompt-input" dir="auto" rows={2} value={prompt} placeholder={element ? t('What should change on this element?') : t('What should change?')} data-testid="live-prompt" onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(); } }} />
            {running
              ? <IconButton className="prompt-stop" icon={<Square size={12} />} title={t('Stop')} onClick={() => void api.stopRun(runId!)} testId="live-stop" />
              : <IconButton className="prompt-send" icon={<ArrowUp size={14} />} title={t('Send')} disabled={!prompt.trim() || !runner} onClick={() => void ask()} testId="live-send" />}
          </div>
          <div className="live-choice">
            {runners.length ? <SelectField<string> value={runner} options={runners.map((r) => ({ value: r.id, label: r.available ? runnerName(r.id) : t('{runner} (not found)', { runner: runnerName(r.id) }), disabled: !r.available }))} onChange={setRunner} testId="live-runner" title={t('Which CLI runs this')} /> : null}
            {runner ? <RunChoice runner={runner} scope="prompt" testId="live-choice" /> : null}
          </div>
        </div>
        <div className="section-plain live-history">
          <div className="feed-title">{t('Runs on this project')}</div>
          {!history.length ? <div className="hint">{t('None yet.')}</div> : null}
          {history.slice(0, 20).map((r) => (
            <div key={r.id} className={`run-row is-${r.status}`} data-testid="live-run">
              <div className="run-head"><span className="run-dot" /><span className="run-prompt" dir="auto">{r.title || r.prompt}</span><span className="run-when">{duration(r.durationMs)}</span></div>
              {r.files?.length ? <div className="run-meta" data-testid="live-run-files">{r.files.join(', ')}</div> : null}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
