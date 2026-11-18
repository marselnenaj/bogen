import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '../i18n/react.ts';
import { continueAfterInstall, holdToTalk, installForCall, useCall } from './call-session.ts';
import { CallHead, CallMore, EndButton, isLive, liveWords, lookOf, MuteButton, retryCall, runnerName, setTranscript, useTranscriptOpen } from './CallStrip.tsx';

function megabytes(bytes: number): string { return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`; }

/**
 * The call in its own file: a card under the chat's header, so the header and the button that started the call stay
 * where the pointer is. Its head says what happens and where, with the clock at the right; under it the last thing
 * said, in two lines whose room is kept (or the problem, or the download, in the same place); then Mute, Transcript,
 * More and End, which stay in every state. The agent's whole answer, its steps and the details stay in the chat.
 * Designed in Bogen: file "Bogen Brand System", page "Call bar", row "Call v4" (artboard d16me9hp0e).
 */
export function CallPanel() {
  const t = useT();
  const s = useCall((x) => x);
  const transcript = useTranscriptOpen();
  const [withModel, setWithModel] = useState(false);
  const [needs, setNeeds] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);
  const look = lookOf(s);
  const live = isLive(look);
  const agent = runnerName();
  const talk = s.status?.talk;
  const model = talk?.models.find((m) => m.recommended);
  useEffect(() => { if (talk && model && !model.installed) setWithModel(!talk.claude); }, [talk?.claude, model?.installed]);
  useEffect(() => { if (transcript) logRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' }); }, [transcript, s.captions.length]);
  // A new call starts with the last thing said, not with the transcript of the one before.
  useEffect(() => { if (!s.active) setTranscript(false); }, [s.active]);
  const need = s.status ? [
    ...(s.status.listen.installed ? [] : [{ name: s.status.listen.engine === 'parakeet' ? t('Speech recognition (NVIDIA Parakeet v3, German and English)') : s.status.listen.engine === 'whisper-gpu' ? t('Speech recognition on the graphics card (Whisper large-v3-turbo, German and English)') : t('Speech recognition (Whisper base, German and English)'), bytes: s.status.listen.bytes, licence: s.status.listen.attribution ? `${s.status.listen.licence}. ${s.status.listen.attribution}` : s.status.listen.licence }]),
    ...s.status.voices.filter((v) => v.language === s.language && (s.voices[s.language] ? v.id === s.voices[s.language] : v.preferred) && !v.installed).map((v) => ({ name: v.name, bytes: v.bytes, licence: v.attribution ? `${v.licence}. ${v.attribution}` : v.licence })),
  ] : [];
  const total = need.reduce((n, x) => n + x.bytes, 0);
  const missingTools = s.status && s.status.listen.engine === 'voxtype' && (!s.status.listen.voxtype || !s.status.listen.ffmpeg);
  const last = s.captions.at(-1);
  const hearing = look === 'you' && last?.who === 'you';
  const lastSaid = [...s.captions].reverse().find((c) => c.who === 'agent');
  const shown = hearing ? last : lastSaid;
  const showLog = transcript && live && s.captions.length > 0;

  return (
    <section className="call-panel" aria-label={t('Call with the agent')} data-testid="call-panel" data-look={look}>
      <div className="call-head">
        <CallHead s={s} look={look} agent={agent} testIds={{ title: 'call-turn', sub: 'call-sub' }} where="card" />
        <span className="call-live" aria-live="polite">{liveWords(s, look, agent, t)}</span>
      </div>

      <div className="call-body">
        {look === 'setup' ? (
          <div className="call-box" data-testid="call-setup">
            {missingTools ? <p>{t('Speech recognition needs Voxtype and ffmpeg on this computer. Install Dictation in Omarchy (Install > AI > Dictation), then open the call again.')}</p> : null}
            {need.length ? (
              <>
                <p>{t('A call needs {size} of speech models, once. They run on this computer.', { size: megabytes(total) })}</p>
                <button type="button" className="call-disclosure" aria-expanded={needs} onClick={() => setNeeds(!needs)}>{needs ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}{t('What gets downloaded')}</button>
                {needs ? <ul className="call-needs">{need.map((n) => <li key={n.name}><span>{n.name}</span> <span className="call-note">{megabytes(n.bytes)} · {n.licence}</span></li>)}</ul> : null}
                {model && !model.installed ? (
                  <label className="call-check" title={model.label}>
                    <input type="checkbox" checked={withModel} onChange={(e) => setWithModel(e.target.checked)} data-testid="call-with-model" />
                    <span>{t('Also download a voice model for this computer ({size}), so the voice can talk without a subscription.', { size: megabytes(model.bytes) })}</span>
                  </label>
                ) : null}
                <button type="button" className="call-btn is-primary" disabled={s.installing} onClick={() => void installForCall(s.language, withModel).then(continueAfterInstall)} data-testid="call-install">{s.installing ? t('Downloading…') : t('Download and start')}</button>
              </>
            ) : null}
          </div>
        ) : look === 'error' ? (
          // The problem takes the last line's place, at its size; Try again sits with the controls, so End stays put.
          <div className="call-said is-error" role="alert" data-testid="call-error">
            <p className="call-line">{s.errorKind === 'mic' ? t('Allow the microphone in the site settings, then try again.') : s.error}</p>
          </div>
        ) : showLog ? (
          <div className="call-log" data-testid="call-transcript">
            <div className="call-log-head"><span>{t('This call so far')}</span><button type="button" className="call-link-btn" onClick={() => setTranscript(false)} data-testid="call-transcript-close">{t('Close')}</button></div>
            <ol ref={logRef}>
              {s.captions.map((c, i) => <li key={`${c.at}-${i}`} dir="auto"><span className="call-log-who">{c.who === 'you' ? t('You') : agent}</span><span>{c.text}</span></li>)}
            </ol>
          </div>
        ) : (
          <div className="call-said" data-testid="call-said">
            {shown && look !== 'connecting' ? <p className={`call-line${hearing ? ' is-yours' : ''}${look === 'muted' || look === 'reconnecting' ? ' is-past' : ''}`} dir="auto">{shown.text}</p>
              : <p className="call-line is-hint">{t('Say what should change, for example: “Make the headline bigger.”')}</p>}
          </div>
        )}
        {live && s.mode === 'hold' ? (
          <div className="call-hold">
            <button type="button" className="call-btn is-wide" onPointerDown={() => holdToTalk(true)} onPointerUp={() => holdToTalk(false)} onPointerLeave={() => holdToTalk(false)} onKeyDown={(e) => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); holdToTalk(true); } }} onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') holdToTalk(false); }} data-testid="call-hold">{t('Hold to talk')}</button>
          </div>
        ) : null}
      </div>

      <div className="call-controls" data-testid="call-controls">
        <MuteButton testId="call-mute" disabled={!live || look === 'connecting' || look === 'reconnecting'} />
        <CallMore testId="call-more" />
        {look === 'error' ? <button type="button" className="call-btn is-strong" onClick={retryCall} data-testid="call-retry">{t('Try again')}</button> : null}
        <span className="call-gap" />
        <EndButton testId="call-hangup" early={look === 'setup'} />
      </div>
    </section>
  );
}
