import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Mic, MicOff, X } from 'lucide-react';
import type { CommentAttachment } from '@bogen/core';
import { canRecord, dropRecording, MAX_RECORD_SECONDS, sendRecording, startRecording, voiceStatus, type Recording, type VoiceStatus } from '../phone/voice.ts';
import { editor } from '../state/store.ts';
import { useT } from '../i18n/react.ts';
import { IconButton } from './controls.tsx';
import { clockOf } from './VoiceNote.tsx';
import { canStart, micProblem, pushLevel, voiceOutcome, type VoicePhase, type VoiceProblem, type VoiceUse } from './voice-state.ts';

/**
 * The microphone of the editor's chat and comment boxes. It records here, the computer writes it out with its own
 * speech model, and the words go into the field to be checked before sending. See voice-state.ts.
 */

export interface Voice {
  use: VoiceUse;
  phase: VoicePhase;
  seconds: number;
  levels: number[];
  problem: VoiceProblem | null;
  /** The server's or the browser's own words for a failure. */
  detail: string;
  /** What happened last, for the line under the field. */
  note: string | null;
  status: VoiceStatus | null;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  dismiss: () => void;
  recheck: () => void;
}

export function useVoice({ use, onText, onAttach, onDone }: { use: VoiceUse; onText: (words: string) => void; onAttach?: (file: CommentAttachment) => void; onDone?: () => void }): Voice {
  const t = useT();
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [problem, setProblem] = useState<VoiceProblem | null>(null);
  const [detail, setDetail] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const recording = useRef<Recording | null>(null);
  const live = useRef(true);
  const handlers = useRef({ onText, onAttach, onDone });
  handlers.current = { onText, onAttach, onDone };

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      recording.current?.cancel();
      recording.current = null;
    };
  }, []);

  useEffect(() => {
    if (phase !== 'recording') return;
    const since = performance.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds((performance.now() - since) / 1000), 250);
    return () => clearInterval(timer);
  }, [phase]);

  const stop = useCallback(async () => {
    const r = recording.current;
    const fileId = editor().fileId;
    if (!r || !fileId) return;
    recording.current = null;
    setPhase('transcribing');
    try {
      const { blob, seconds: length } = await r.stop();
      const out = voiceOutcome(await sendRecording(fileId, blob, length), use);
      if (!live.current) {
        if (out.kind !== 'text') dropRecording(out.attachment);
        return;
      }
      if (out.kind === 'text') {
        handlers.current.onText(out.text);
        setNote(t('Written out with {transcriber} on this computer, and the recording is deleted. Check it, then send.', { transcriber: out.transcriber }));
      } else if (out.kind === 'attach') {
        handlers.current.onAttach?.(out.attachment);
        setNote(t('No local speech model here, so it goes as a voice note that plays on this computer. An agent cannot hear it: add a line for it.'));
      } else {
        dropRecording(out.attachment);
        setProblem(out.problem);
        setDetail(out.reason);
      }
    } catch (e) {
      if (live.current) {
        setProblem('failed');
        setDetail((e as Error).message);
      }
    } finally {
      if (live.current) {
        setPhase('idle');
        handlers.current.onDone?.();
      }
    }
  }, [use, t]);

  const start = useCallback(async () => {
    if (recording.current || phase !== 'idle') return;
    setNote(null);
    setProblem(null);
    setDetail('');
    if (!canRecord() || !editor().fileId) return void setProblem('unsupported');
    const found = await voiceStatus();
    if (!live.current) return;
    setStatus(found);
    const blocked = canStart(use, found);
    if (blocked) return void setProblem(blocked);
    setLevels([]);
    try {
      recording.current = await startRecording((level) => setLevels((prev) => pushLevel(prev, level)), () => void stop());
      if (!live.current) {
        recording.current.cancel();
        recording.current = null;
        return;
      }
      setPhase('recording');
    } catch (e) {
      setProblem(micProblem(e));
      setDetail((e as Error).message ?? '');
    }
  }, [phase, use, stop]);

  const cancel = useCallback(() => {
    recording.current?.cancel();
    recording.current = null;
    setPhase('idle');
    setNote(null);
    handlers.current.onDone?.();
  }, []);

  const recheck = useCallback(async () => {
    const found = await voiceStatus(true);
    if (!live.current) return;
    setStatus(found);
    if (found?.transcriber) {
      setProblem(null);
      setNote(t('Found {transcriber}. Speak again.', { transcriber: found.transcriber.name }));
    }
  }, [t]);

  return {
    use, phase, seconds, levels, problem, detail, note, status,
    start: () => void start(), stop: () => void stop(), cancel, recheck: () => void recheck(),
    dismiss: () => { setProblem(null); setNote(null); },
  };
}

/** The microphone button, while nothing is being recorded. */
export function MicButton({ voice, testId, size = 14 }: { voice: Voice; testId: string; size?: number }) {
  const t = useT();
  const off = voice.problem === 'denied' || voice.problem === 'no-mic';
  return (
    <IconButton
      className={`mic-btn${voice.problem ? ' has-problem' : ''}`}
      icon={off ? <MicOff size={size} /> : <Mic size={size} />}
      title={voice.phase === 'transcribing' ? t('Writing it out') : t('Speak instead of typing')}
      disabled={voice.phase !== 'idle'}
      onClick={voice.start}
      testId={testId}
    />
  );
}

/** The recording row: cancel, the time, the level, and Write it out, which takes the focus so Enter and Space stop. */
export function VoiceRecording({ voice, testId }: { voice: Voice; testId: string }) {
  const t = useT();
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (voice.phase === 'recording') done.current?.focus(); }, [voice.phase]);
  if (voice.phase !== 'recording') return null;
  const time = clockOf(voice.seconds);
  return (
    <div className="voice-rec" role="group" aria-label={t('Recording, {time}', { time })} data-testid={`${testId}-recording`} onKeyDown={(e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { e.preventDefault(); voice.cancel(); }
    }}>
      <IconButton icon={<X size={13} />} title={t('Cancel the recording')} onClick={voice.cancel} testId={`${testId}-cancel`} />
      <span className="voice-rec-dot" aria-hidden="true" />
      <span className="voice-rec-time" aria-live="off">{time}</span>
      <span className="voice-rec-meter" aria-hidden="true">
        {Array.from({ length: 20 }, (_, i) => {
          const level = voice.levels[voice.levels.length - 20 + i] ?? 0;
          return <span key={i} style={{ height: `${Math.round(3 + level * 15)}px` }} />;
        })}
      </span>
      <button ref={done} type="button" className="voice-rec-done" onClick={voice.stop} data-testid={`${testId}-done`}><Check size={12} strokeWidth={2.5} /> {t('Write it out')}</button>
    </div>
  );
}

/** The line under the field: what the microphone is doing, what came of it, or what stands in its way. */
export function VoiceNotice({ voice, testId }: { voice: Voice; testId: string }) {
  const t = useT();
  const name = voice.status?.transcriber?.name;
  if (voice.phase === 'recording') {
    const line = voice.use === 'comment' && voice.status && !voice.status.transcriber
      ? t('Listening. Without a local speech model it stays a voice note on this computer. Esc cancels.')
      : name ? t('Listening. {transcriber} writes it out on this computer, nothing goes online. Esc cancels.', { transcriber: name }) : t('Listening. It is written out on this computer, nothing goes online. Esc cancels.');
    return <p className="voice-note" role="status" data-testid={`${testId}-voice-note`} data-state="recording">{line}{' '}{t('It stops by itself at {time}.', { time: clockOf(MAX_RECORD_SECONDS) })}</p>;
  }
  if (voice.phase === 'transcribing') return <p className="voice-note is-busy" role="status" data-testid={`${testId}-voice-note`} data-state="transcribing">{name ? t('Writing it out with {transcriber}', { transcriber: name }) : t('Writing it out')}</p>;
  if (voice.problem === 'no-model') {
    return (
      <div className="voice-setup" role="dialog" aria-label={t('Speech needs a local model')} data-testid={`${testId}-voice-setup`}>
        <strong>{t('Speech needs a local model')}</strong>
        <p>{t('Bogen writes speech out only on this computer, and there is no speech model here yet.')}</p>
        <ul>
          <li>{t.rich('On Omarchy, pick Voxtype in the Omarchy menu under Setup, Defaults, Dictation, or run {command}. Bogen finds it by itself.', { command: <code>omarchy-install-dictation-voxtype</code> })}</li>
          <li>{t.rich('Or whisper.cpp with a model in {path}', { path: <code>~/.local/share/whisper.cpp/models</code> })}</li>
          <li>{t.rich('Or your own command in {name}', { name: <code>BOGEN_TRANSCRIBER</code> })}</li>
        </ul>
        <div className="voice-setup-actions">
          <button type="button" className="btn-primary" onClick={voice.recheck} data-testid={`${testId}-voice-recheck`}>{t('Check again')}</button>
          <button type="button" className="run-link" onClick={voice.dismiss}>{t('Close')}</button>
        </div>
      </div>
    );
  }
  if (voice.problem) {
    const line = voice.problem === 'denied' ? t('The microphone is blocked for Bogen. Allow it in the browser\'s site settings, then try again.')
      : voice.problem === 'no-mic' ? t('No microphone was found. Connect one, then try again.')
      : voice.problem === 'unsupported' ? t('This browser cannot record here.')
      : voice.problem === 'nothing' ? t('Nothing was understood in the recording. Try again a little closer to the microphone.')
      : voice.detail ? t('The recording did not work: {error}', { error: voice.detail }) : t('The recording did not work.');
    return (
      <div className="voice-problem" role="alert" data-testid={`${testId}-voice-problem`} data-problem={voice.problem}>
        <MicOff size={13} aria-hidden="true" />
        <span>{line}</span>
        {voice.problem !== 'unsupported' ? <button type="button" className="voice-problem-retry" onClick={voice.start}>{t('Try again')}</button> : null}
        <IconButton icon={<X size={11} />} title={t('Close')} onClick={voice.dismiss} />
      </div>
    );
  }
  if (voice.note) return <p className="voice-note" role="status" data-testid={`${testId}-voice-note`} data-state="done">{voice.note}</p>;
  return null;
}
