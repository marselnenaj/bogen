import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ImagePlus, Square } from 'lucide-react';
import { RUNNERS, type RunnerId } from '@bogen/core';
import { useSelectedNodes } from '../doc/hooks.ts';
import { api, type Runner } from '../lib/api.ts';
import { askAbout, newAsk, sendAsk, stopAsk, useAsk } from './ask-state.ts';
import { Result } from './Ask.tsx';
import { usePhoneFile } from './file-state.ts';
import { runnerName } from './phone-api.ts';
import { Sheet } from './Sheet.tsx';
import { PhotoChip, usePhotoPicker } from './PhotoSheet.tsx';
import type { Photo } from './photo.ts';
import { useT } from '../i18n/react.ts';

/**
 * D6: ask the agent on the computer about what is selected, or the board in view. It runs the way Ask
 * does (ask-state.ts): an ordinary run asked for proposals, which come back here to accept or discard.
 */
export function AskSheet({ fileId, onClose }: { fileId: string; onClose: () => void }) {
  const t = useT();
  const nodes = useSelectedNodes();
  const boards = usePhoneFile((s) => s.boards);
  const boardId = usePhoneFile((s) => s.boardId);
  const { runner, messages, runId, steps, queued, set } = useAsk();
  const [runners, setRunners] = useState<Runner[]>([]);
  const [machine, setMachine] = useState('PC');
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState<Photo | null>(null);
  const picker = usePhotoPicker(setPhoto);
  const end = useRef<HTMLDivElement>(null);

  const node = nodes[0];
  const board = boards.find((b) => b.id === boardId);
  const about = node ? nodes.map((n) => n.id) : board ? [board.id] : [];
  const chip = node ? [node.name, board && board.id !== node.id ? board.name : null].filter(Boolean).join(' · ') : board?.name;

  useEffect(() => { askAbout(fileId, about); }, [fileId, about.join()]);
  useEffect(() => {
    void api.runners().then((list) => {
      setRunners(list);
      const usable = list.filter((r) => r.available);
      if (usable.length && !usable.some((r) => r.id === useAsk.getState().runner)) set({ runner: usable[0]!.id as RunnerId });
    }, () => {});
    void api.status().then((st) => setMachine((st as { device?: { name: string } }).device?.name ?? 'PC'), () => {});
  }, [set]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [messages, steps]);

  const usable = runners.filter((r) => r.available);
  const send = (body: string) => {
    if (!body.trim()) return;
    void sendAsk(body, photo ?? undefined);
    setText('');
    setPhoto(null);
  };
  const width = board ? Math.round(board.w) : null;
  const suggestions = [width ? t('Make it work at {width}', { width }) : t('Make it work on a phone'), t('Tighter, on brand'), t('Three directions')];

  return (
    <Sheet
      dark
      title={t('Ask {agent}', { agent: runnerName(runner) })}
      aside={(
        <label className="pf-runner">
          <span>{runnerName(runner)} · {machine} ▾</span>
          <select value={runner} onChange={(e) => { const next = e.target.value as RunnerId; set({ runner: next }); if (!RUNNERS[next].images) setPhoto(null); }} aria-label={t('Agent')} data-testid="pf-ask-runner">
            {(usable.length ? usable : [{ id: 'claude' }, { id: 'codex' }]).map((r) => <option key={r.id} value={r.id}>{runnerName(r.id)}</option>)}
          </select>
        </label>
      )}
      onClose={onClose}
      testId="pf-ask"
      foot={(
        <>
        {photo ? <PhotoChip photo={photo} onRemove={() => setPhoto(null)} testId="pf-ask-photo" /> : null}
        {picker.busy || picker.error ? <p className="pf-compose-note is-dark" role="status">{picker.busy ? t('Sending the photo to your computer.') : picker.error}</p> : null}
        <form className="pf-compose is-dark" onSubmit={(e) => { e.preventDefault(); send(text); }}>
          <button type="button" className="pf-mic is-dark" disabled={picker.busy || Boolean(runId) || !RUNNERS[runner].images} onClick={() => picker.pick(false)} aria-label={RUNNERS[runner].images ? t('Attach a photo') : t('{agent} takes no images here', { agent: runnerName(runner) })} title={RUNNERS[runner].images ? undefined : t('{agent} takes no images here', { agent: runnerName(runner) })} data-testid="pf-ask-attach"><ImagePlus size={22} strokeWidth={2.25} /></button>
          <input className="pf-compose-input" value={text} onChange={(e) => setText(e.target.value)} dir="auto" placeholder={runId ? t('Say something when it is done') : t('What should change?')} aria-label={t('What should change?')} enterKeyHint="send" data-testid="pf-ask-input" />
          {runId && !text.trim()
            ? <button type="button" className="pf-send is-stop" onClick={stopAsk} aria-label={t('Stop')} data-testid="pf-ask-stop"><Square size={18} strokeWidth={2.6} /></button>
            : <button type="submit" className="pf-send" disabled={!text.trim()} aria-label={t('Send')} data-testid="pf-ask-send"><ArrowUp size={22} strokeWidth={2.5} /></button>}
        </form>
        </>
      )}
    >
      {chip ? <p className="pf-chip" dir="auto" data-testid="pf-ask-chip">{chip}</p> : null}
      {!messages.length ? (
        <>
          <p className="pf-ask-hint">{node ? t('Ask about the selection. The answer comes as a proposal you accept or discard here.') : t('Ask about the board. The answer comes as a proposal you accept or discard here.')}</p>
          <div className="pf-suggestions">
            {suggestions.map((sug) => <button key={sug} type="button" className="pf-suggestion" onClick={() => send(sug)} data-testid="pf-ask-suggestion">{sug}</button>)}
          </div>
        </>
      ) : (
        <div className="pf-ask-thread" data-testid="pf-ask-thread">
          {!runId ? <button type="button" className="phone-link" onClick={newAsk} data-testid="pf-ask-new-chat">{t('New chat')}</button> : null}
          {messages.map((m, i) => m.role === 'user' ? <p key={i} className="phone-msg is-mine" dir="auto">{m.photo ? <img className="phone-msg-photo" src={m.photo} alt={t('Photo sent with this message')} /> : null}{m.text}</p> : (
            <div key={i} className="phone-msg is-agent">
              {m.text ? <p dir="auto">{m.text.trim()}</p> : null}
              {!m.done && m.runId === runId ? <ol className="pf-ask-steps" aria-live="polite">{(steps.length ? steps : [t('Starting on the computer')]).slice(-4).map((st, j, all) => <li key={j} className={j === all.length - 1 ? 'is-now' : ''}>{st}</li>)}</ol> : null}
              {m.error ? <p className="phone-error">{m.error}</p> : null}
              {m.done && !m.text && !m.error && !m.proposals.length ? <p className="phone-dim">{t('Done, without a word.')}</p> : null}
              {m.proposals.map((p) => <Result key={p.id} made={p} {...(m.score !== undefined ? { score: m.score } : {})} />)}
            </div>
          ))}
          {queued ? <p className="phone-dim">{t('Sends when {agent} is done: “{message}”', { agent: runnerName(runner), message: queued })}</p> : null}
          <div ref={end} />
        </div>
      )}
    </Sheet>
  );
}
