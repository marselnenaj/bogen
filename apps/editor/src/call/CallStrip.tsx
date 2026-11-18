import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, AudioLines, CircleAlert, Download, Ear, EarOff, Mic, MicOff, MoreHorizontal, Phone, PhoneOff, RefreshCw, Sparkles } from 'lucide-react';
import { spokenName } from '@bogen/core';
import { useT } from '../i18n/react.ts';
import { Popover } from '../ui/controls.tsx';
import { backToCall, callState, endCall, setFollow, setMode, setMuted, startCall, useCall, type CallState } from './call-session.ts';
import { agentName } from './incoming.ts';

/**
 * The parts the call's card (in the chat of its file) and the call's bar (everywhere else) share: an avatar whose ring
 * carries the state, a title that says what happens, a line under it that says where, the clock at the right, and
 * Mute, More and End in the same order. Controls never come and go with the state; they are disabled instead.
 * Designed in Bogen: file "Bogen Brand System", page "Call bar", row "Call v4" (artboards d16me9hp0e, ge259n7rvs).
 */

export type Look = 'setup' | 'error' | 'connecting' | 'reconnecting' | 'muted' | 'agent' | 'you' | 'moved' | 'working' | 'listening';

export function lookOf(s: CallState): Look {
  if (s.error) return 'error';
  if (s.status && !s.status.ready[s.language] && !s.connecting) return 'setup';
  if (s.connecting) return 'connecting';
  if (s.reconnecting) return 'reconnecting';
  // The call just moved: an event of five seconds, shown over muted, then the call's state again.
  if (s.followed && !s.speaking) return 'moved';
  if (s.muted) return 'muted';
  if (s.speaking) return 'agent';
  if (s.turn === 'hearing' || s.turn === 'interrupted') return 'you';
  if (s.working) return 'working';
  return 'listening';
}

/** The looks in which the microphone and the clock run: the call is live. */
export function isLive(look: Look): boolean { return look !== 'setup' && look !== 'error'; }

export function clock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A running clock that changes its own text, so the strip around it does not render every second. */
export function Elapsed({ since, className, hidden = false, testId }: { since: number | null; className: string; hidden?: boolean; testId?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!since) return;
    const tick = () => { if (ref.current) ref.current.textContent = clock(Math.max(0, Math.floor((Date.now() - since) / 1000))); };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [since]);
  // Hidden, it keeps its width, so the title does not move when the clock comes back.
  return <span ref={ref} className={className} data-testid={testId} aria-hidden={hidden || undefined} style={hidden ? { visibility: 'hidden' } : undefined}>0:00</span>;
}

export function runnerName(): string {
  let saved: string | null = null;
  try { saved = localStorage.getItem('bogen-prompt-runner'); } catch { /* none */ }
  return agentName(saved ?? 'claude');
}

/**
 * The avatar: a glyph for the state in a disc, and a ring around it. Blue is you and the live line (its halo grows
 * with the microphone's level), amber is the agent speaking or working, a turning dashed ring is connecting. The
 * glyph says the same without colour: an ear listening (crossed out when muted), a waveform speaking, a spark
 * working. The microphone glyph belongs to the Mute button alone.
 */
export function Orb({ look, agent, level = 0, errorKind = null }: { look: Look; agent: string; level?: number; errorKind?: CallState['errorKind'] }) {
  const inner = look === 'error' ? (errorKind === 'mic' ? <MicOff size={18} /> : <CircleAlert size={18} />)
    : look === 'setup' ? <Download size={18} />
    : look === 'you' || look === 'agent' ? <AudioLines size={18} />
    : look === 'working' ? <Sparkles size={18} />
    : look === 'muted' ? <EarOff size={18} />
    : look === 'moved' ? <ArrowRight size={18} />
    : look === 'listening' ? <Ear size={18} />
    : look === 'reconnecting' ? <RefreshCw size={18} />
    : <Phone size={18} />;
  return <span className={`call-orb is-${look}`} style={{ '--call-level': Math.min(1, Math.max(0, level)).toFixed(2) } as CSSProperties} aria-hidden="true" data-look={look}>{inner}</span>;
}

/** What happens, in a few words: the title of the card and the bar. */
export function titleOf(s: CallState, look: Look, agent: string, t: ReturnType<typeof useT>): string {
  switch (look) {
    case 'setup': return t('One download needed');
    case 'error': return s.errorKind === 'mic' ? t('Microphone blocked') : t('That did not work');
    case 'connecting': return t('Connecting…');
    case 'reconnecting': return t('Reconnecting…');
    case 'muted': return t('Muted');
    case 'agent': return t('{agent} is speaking', { agent });
    case 'you': return t('You are speaking');
    case 'moved': return t('Call moved');
    // A run left behind in the file the call moved from is not a second agent of the call: it finishes there.
    case 'working': return s.runFile ? t('Finishing in {file}', { file: spokenName(s.runFile) }) : t('{agent} is working', { agent });
    default: return t('Listening');
  }
}

/**
 * Under the title. In the bar, where the call is (its file), or the words being said while someone speaks. In the card,
 * which is in the call's file already, what to do or what the agent does.
 */
export function subOf(s: CallState, look: Look, agent: string, t: ReturnType<typeof useT>, where: 'card' | 'bar' = 'bar'): string {
  const file = spokenName(s.fileName ?? '') || t('this design');
  if (look === 'setup') return t('Before the first call');
  if (look === 'reconnecting') return t('Waiting for the connection');
  if (look === 'muted') return t('{agent} cannot hear you', { agent });
  if (look === 'moved') return s.followed!.runIn ? t('{file} finishes its run first', { file: spokenName(s.followed!.runIn) }) : s.followed!.name;
  const doing = s.working && s.activity && (look === 'working' || look === 'listening') ? t(s.activity) : null;
  // In the bar it is always the same shape: what the agent does, if anything, then the call's file. What a run finishing
  // in another file does is not named next to the call's file, where it would read as work there.
  if (where === 'bar') return doing && !s.runFile ? `${doing} · ${file}` : file;
  if (doing) return doing;
  if (look === 'error') return s.errorKind === 'mic' ? t('{agent} cannot hear you', { agent }) : t('Try again, or end the call');
  if (look === 'connecting') return t('Starting the microphone and the voice');
  if (look === 'agent') return t('Speak to interrupt');
  if (look === 'you') return t('{agent} is listening', { agent });
  return t('Speak any time');
}

/** The head of the card and the content of the bar's open-the-call button: avatar, title, where, clock. */
export function CallHead({ s, look, agent, testIds, where }: { s: CallState; look: Look; agent: string; testIds: { title: string; sub: string }; where: 'card' | 'bar' }) {
  const t = useT();
  const title = titleOf(s, look, agent, t);
  const sub = subOf(s, look, agent, t, where);
  return (
    <>
      <Orb look={look} agent={agent} level={look === 'you' || look === 'listening' || look === 'moved' ? s.level : 0} errorKind={s.errorKind} />
      <span className="call-text">
        <span className="call-status" data-testid={testIds.title}>{title}</span>
        <span className="call-quiet" dir="auto" data-testid={testIds.sub} title={look === 'moved' ? s.followed!.name : undefined}>{sub}</span>
      </span>
      {/* The clock starts when the call is connected; until then, and during a problem, it keeps its place unseen. */}
      <Elapsed since={s.startedAt} className="call-time" hidden={!isLive(look) || look === 'connecting' || !s.startedAt} testId="call-clock" />
    </>
  );
}

/** What a screen reader hears when the state changes: only the changes that matter. */
export function liveWords(s: CallState, look: Look, agent: string, t: ReturnType<typeof useT>): string {
  if (look === 'agent' || look === 'working' || look === 'reconnecting' || look === 'connecting') return titleOf(s, look, agent, t);
  if (look === 'moved') return t('The call is in {file} now', { file: s.followed!.name });
  return '';
}

// The transcript is one thing for the whole call: More opens it in the card, from the card or from the bar.
let transcriptOpen = false;
const transcriptListeners = new Set<() => void>();
export function setTranscript(open: boolean): void { transcriptOpen = open; transcriptListeners.forEach((l) => l()); }
export function useTranscriptOpen(): boolean {
  return useSyncExternalStore((l) => { transcriptListeners.add(l); return () => transcriptListeners.delete(l); }, () => transcriptOpen);
}

/** Starts the call again in its file, after a problem. */
export function retryCall(): void {
  const { fileId, fileName } = callState();
  endCall();
  if (fileId) void startCall({ fileId, ...(fileName ? { fileName } : {}) });
}

/** The More menu: hold to talk and moving with the file (each with a small switch), the transcript, Call settings. */
export function CallMore({ testId, inBar = false }: { testId: string; inBar?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const mode = useCall((x) => x.mode);
  const follow = useCall((x) => x.follow);
  const said = useCall((x) => x.captions.length > 0);
  const transcript = useTranscriptOpen();
  const close = () => setOpen(false);
  const tick = (on: boolean) => <span className={`call-menu-switch${on ? ' is-on' : ''}`} aria-hidden="true"><span /></span>;
  return (
    <>
      <button ref={ref} type="button" className="call-ib" aria-label={t('More')} title={t('More')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={testId}><MoreHorizontal size={16} aria-hidden="true" /></button>
      {open ? (
        <Popover anchor={ref.current} side="below" align="end" width={240} onClose={close} focus>
          <div role="menu" aria-label={t('Call')}>
            <button type="button" className="menu-item" role="menuitemcheckbox" aria-checked={mode === 'hold'} onClick={() => { close(); setMode(mode === 'hold' ? 'open' : 'hold'); }} data-testid="call-menu-hold"><span className="call-menu-row">{t('Hold to talk')}{tick(mode === 'hold')}</span></button>
            <button type="button" className="menu-item" role="menuitemcheckbox" aria-checked={follow} onClick={() => { close(); setFollow(!follow); }} data-testid="call-menu-follow"><span className="call-menu-row">{t('Move with the file you open')}{tick(follow)}</span></button>
            <div className="menu-sep" />
            <button type="button" className="menu-item" role="menuitem" disabled={!said} onClick={() => { close(); setTranscript(inBar ? true : !transcript); if (inBar) backToCall(); }} data-testid="call-menu-transcript">{transcript && !inBar ? t('Hide the transcript') : t('Show the transcript')}</button>
            <button type="button" className="menu-item" role="menuitem" onClick={() => { close(); openCallSettings(); }} data-testid="call-menu-settings">{t('Call settings…')}</button>
          </div>
        </Popover>
      ) : null}
    </>
  );
}

export function MuteButton({ testId, disabled = false }: { testId: string; disabled?: boolean }) {
  const t = useT();
  const muted = useCall((x) => x.muted);
  return (
    <button type="button" className="call-ib" aria-pressed={muted} aria-label={muted ? t('Unmute') : t('Mute')} title={muted ? t('Unmute') : t('Mute')} disabled={disabled} onClick={() => setMuted(!muted)} data-testid={testId}>
      {muted ? <MicOff size={16} aria-hidden="true" /> : <Mic size={16} aria-hidden="true" />}
    </button>
  );
}

export function EndButton({ testId, word = true, early = false }: { testId: string; word?: boolean; early?: boolean }): ReactNode {
  const t = useT();
  // Before the call has started (its first download), there is nothing to hang up: the same button says "Not now".
  if (early) return <button type="button" className="call-btn call-end-early" onClick={() => endCall()} data-testid={testId}>{t('Not now')}</button>;
  return (
    <button type="button" className={`call-end${word ? '' : ' is-icon'}`} onClick={() => endCall()} aria-label={t('End the call')} title={t('End the call')} data-testid={testId}>
      <PhoneOff size={16} aria-hidden="true" className="call-end-icon" /><span className="call-end-word" aria-hidden="true">{t('End')}</span>
    </button>
  );
}

// Call settings open from More in the card or the bar; the dialog is drawn once, by the dock.
let settingsOpen = false;
const settingsListeners = new Set<() => void>();
export function openCallSettings(): void { settingsOpen = true; settingsListeners.forEach((l) => l()); }
export function closeCallSettings(): void { settingsOpen = false; settingsListeners.forEach((l) => l()); }
export function useCallSettingsOpen(): boolean {
  return useSyncExternalStore((l) => { settingsListeners.add(l); return () => settingsListeners.delete(l); }, () => settingsOpen);
}
