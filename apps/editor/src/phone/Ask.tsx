import { useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type { RunnerId } from '@bogen/core';
import { api, type FileEntry, type Runner } from '../lib/api.ts';
import { askTargets } from './phone-files.ts';
import { loadUser } from '../lib/user.ts';
import { askAbout, newAsk, sendAsk, stopAsk, useAsk, type AskMessage } from './ask-state.ts';
import { decide, layerPicture, runnerName } from './phone-api.ts';
import { WatchCanvas } from './PhoneCanvas.tsx';
import { RunResult } from '../panels/RunResult.tsx';
import { useT } from '../i18n/react.ts';

type Agent = Extract<AskMessage, { role: 'agent' }>;
type Made = Agent['proposals'][number];

function Picture({ fileId, nodeId }: { fileId: string; nodeId: string }) {
  const [src, setSrc] = useState('');
  useEffect(() => { void layerPicture(fileId, nodeId, 1).then(setSrc, () => setSrc('')); }, [fileId, nodeId]);
  return <span className="phone-result-pic">{src ? <img src={src} alt="" /> : null}</span>;
}

/** A proposal the agent made, with the decision right under it. */
export function Result({ made, score }: { made: Made; score?: number }) {
  const t = useT();
  const [state, setState] = useState<'open' | 'accepted' | 'discarded' | 'busy'>('open');
  const act = (decision: 'accept' | 'discard') => {
    setState('busy');
    void decide(made.fileId, made.id, decision, loadUser().name).then(() => setState(decision === 'accept' ? 'accepted' : 'discarded'), () => setState('open'));
  };
  return (
    <div className="phone-result" data-testid="phone-result">
      <div className="phone-result-top">
        <Picture fileId={made.fileId} nodeId={made.id} />
        <p className="phone-result-meta" dir="auto">{made.pageName ?? made.fileName} · {made.ofName || made.name}{score !== undefined ? <><br />{t('Brand check {score}', { score })}</> : null}</p>
      </div>
      {state === 'accepted' || state === 'discarded' ? <p className="phone-result-done">{state === 'accepted' ? t('Accepted.') : t('Discarded.')}</p> : (
        <div className="phone-actions is-inline">
          <button type="button" className="phone-btn is-paper" disabled={state === 'busy'} onClick={() => act('accept')} data-testid="phone-result-accept">{t('Accept')}</button>
          <button type="button" className="phone-btn is-outline-dim" disabled={state === 'busy'} onClick={() => act('discard')}>{t('Discard')}</button>
          <a className="phone-btn is-plain" href={`#/review/${made.fileId}/${made.id}`}>{t('Open')}</a>
        </div>
      )}
    </div>
  );
}

/** C2: the agent at work, live, with what it did so far. */
function Watching({ fileId, runner }: { fileId: string; runner: string }) {
  const t = useT();
  const steps = useAsk((s) => s.steps);
  const queued = useAsk((s) => s.queued);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  return (
    <main className="phone-main phone-watching" data-testid="phone-watching">
      <header className="phone-bar is-dark"><span className="phone-bar-title">{t('Watching {agent}', { agent: runnerName(runner) })}</span><span className="phone-live">{t('Live')}</span></header>
      <WatchCanvas fileId={fileId} />
      <ol className="phone-steps" aria-live="polite">
        {steps.length ? steps.map((s, i) => <li key={i} className={i === steps.length - 1 ? 'is-now' : ''}>{s}</li>) : <li className="is-now">{t('Starting on the PC')}</li>}
      </ol>
      {queued ? <p className="phone-queued">{t('Sends when {agent} is done: “{message}”', { agent: runnerName(runner), message: queued })}</p> : null}
      <footer className="phone-watch-foot">
        <button type="button" className="phone-btn is-outline-light" onClick={stopAsk} data-testid="phone-stop">{t('Stop')}</button>
        {typing ? (
          <form className="phone-say" onSubmit={(e) => { e.preventDefault(); void sendAsk(text); setText(''); setTyping(false); }}>
            <input autoFocus dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Say something')} aria-label={t('Say something')} />
          </form>
        ) : <button type="button" className="phone-btn is-raised" onClick={() => setTyping(true)} data-testid="phone-say">{t('Say something')}</button>}
      </footer>
    </main>
  );
}

/** C1: the thread with the agent on the PC, about one file. */
export function Ask({ fileId: wanted }: { fileId?: string }) {
  const t = useT();
  const { fileId, runner, messages, runId, set } = useAsk();
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [runners, setRunners] = useState<Runner[]>([]);
  const [machine, setMachine] = useState('PC');
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void api.files().then((list) => {
      // The theme projects, never a copy kept inside one as a new target; the file already asked about stays.
      const sorted = askTargets(list, wanted ?? useAsk.getState().fileId);
      setFiles(sorted);
      if (wanted) askAbout(wanted, useAsk.getState().fileId === wanted ? useAsk.getState().nodeIds : []);
      else if (!useAsk.getState().fileId && sorted[0]) askAbout(sorted[0].id);
    }, () => {});
    void api.runners().then((list) => {
      setRunners(list);
      const usable = list.filter((r) => r.available);
      if (usable.length && !usable.some((r) => r.id === useAsk.getState().runner)) set({ runner: usable[0]!.id as RunnerId });
    }, () => {});
    void api.status().then((s) => setMachine((s as { device?: { name: string } }).device?.name ?? 'PC'), () => {});
  }, [wanted, set]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  if (runId && fileId) return <Watching fileId={fileId} runner={runner} />;
  const file = files.find((f) => f.id === fileId);
  const usable = runners.filter((r) => r.available);
  const send = () => {
    void sendAsk(text);
    setText('');
  };

  return (
    <main className="phone-main phone-ask" data-testid="phone-ask">
      <header className="phone-bar is-dark">
        <label className="phone-pick is-title">
          <span dir="auto">{file?.name ?? t('Pick a file')}</span>
          <select value={fileId ?? ''} onChange={(e) => askAbout(e.target.value)} aria-label={t('File')}>
            {files.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        </label>
        <label className="phone-pick is-meta">
          <span>{runnerName(runner)} · {machine}</span>
          <select value={runner} onChange={(e) => set({ runner: e.target.value as RunnerId })} aria-label={t('Agent')} data-testid="phone-runner">
            {(usable.length ? usable : [{ id: 'claude' }, { id: 'codex' }]).map((r) => <option key={r.id} value={r.id}>{runnerName(r.id)}</option>)}
          </select>
        </label>
      </header>
      <div className="phone-thread">
        {messages.length ? <button type="button" className="phone-link" onClick={newAsk} data-testid="phone-new-chat">{t('New chat')}</button> : null}
        {!messages.length ? <p className="phone-thread-empty">{file ? t('Ask {agent} on {machine} for a change to {file}. What it makes comes back as a proposal you can accept here.', { agent: runnerName(runner), machine, file: file.name }) : t('Ask {agent} on {machine} for a change to a file. What it makes comes back as a proposal you can accept here.', { agent: runnerName(runner), machine })}</p> : null}
        {messages.map((m, i) => m.role === 'user' ? <p key={i} className="phone-msg is-mine" dir="auto">{m.text}</p> : (
          <div key={i} className="phone-msg is-agent">
            {m.text ? <p dir="auto">{m.text.trim()}</p> : null}
            {m.error ? <p className="phone-error">{m.error}</p> : null}
            {m.done && !m.text && !m.error && !m.proposals.length ? <p className="phone-dim">{t('Done, without a word.')}</p> : null}
            {m.proposals.map((p) => <Result key={p.id} made={p} {...(m.score !== undefined ? { score: m.score } : {})} />)}
            {m.done && m.runId && fileId ? <RunResult fileId={fileId} runId={m.runId} variant="phone" onLayer={() => { sessionStorage.setItem('bogen-phone-back', '#/ask'); location.hash = `#/file/${fileId}`; }} /> : null}
            {m.done && m.proposals.length === 0 && fileId ? <a className="phone-dim-link" href={`#/file/${fileId}`} onClick={() => sessionStorage.setItem('bogen-phone-back', '#/ask')}>{t('Open the file')}</a> : null}
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="phone-reply" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} dir="auto" placeholder={messages.length ? t('Reply to {agent}', { agent: runnerName(runner) }) : t('Ask {agent}', { agent: runnerName(runner) })} aria-label={t('Message')} disabled={!fileId} data-testid="phone-ask-input" />
        <button type="submit" className="phone-send" disabled={!text.trim() || !fileId} aria-label={t('Send')} data-testid="phone-ask-send"><ArrowUp size={22} strokeWidth={2.5} /></button>
      </form>
    </main>
  );
}
