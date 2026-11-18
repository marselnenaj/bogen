import { useEffect, useRef, useSyncExternalStore } from 'react';
import { ChevronRight, Phone, PhoneMissed, PhoneOff, X } from 'lucide-react';
import { spokenName } from '@bogen/core';
import { useT } from '../i18n/react.ts';
import { useEditor } from '../state/store.ts';
import { usePhone } from '../lib/phone.ts';
import { backToCall, dismissEnded, startCall, useCall, type CallNoteFile } from './call-session.ts';
import { CallHead, CallMore, clock, EndButton, isLive, liveWords, lookOf, MuteButton, retryCall, runnerName, subOf, titleOf } from './CallStrip.tsx';
import { CallSettingsHost } from './CallSettings.tsx';
import { agentName, answerIncoming, declineIncoming, dismissMissed, replyInWriting, useIncoming } from './incoming.ts';
import { ActivityPills, useVisibleActivities } from '../ui/ActivityDock.tsx';

/**
 * The call wherever the person is: the call's bar, floating at the bottom of the content column on every screen
 * except where the call's card already shows it (the call's own file with its chat open). The same avatar, title,
 * clock, Mute, More and End as the card; the whole left part goes back to the call. An agent's incoming call, a missed
 * one and the end of a call are cards of the same width above it. Designed in Bogen: file "Bogen Brand System", page
 * "Call bar", row "Call v4" (artboard ge259n7rvs).
 */

/** The file whose editor is on screen, read from the address: the editor's store keeps the last file after leaving it. */
function useRouteFile(): string | null {
  const hash = useSyncExternalStore((fn) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); }, () => location.hash);
  return /^#\/file\/([\w-]+)(?!\/preview)/.exec(hash)?.[1] ?? null;
}

/** How long an agent's call still rings, as a hairline that runs out: a clock here would read as a call's length. */
function RingHair({ from, until }: { from: number; until: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const total = Math.max(1, until - from);
    const tick = () => { if (ref.current) ref.current.style.transform = `scaleX(${Math.max(0, Math.min(1, (until - Date.now()) / total)).toFixed(3)})`; };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [from, until]);
  return <span className="callbar-hair" aria-hidden="true"><span ref={ref} className="callbar-hair-in" /></span>;
}

function ActiveBar() {
  const t = useT();
  const s = useCall((x) => x);
  const editorFile = useRouteFile();
  const look = lookOf(s);
  const live = isLive(look);
  const agent = runnerName();
  const fileName = s.fileName ?? t('this design');
  const back = editorFile === s.fileId ? t('Open the call') : t('Back to the call in {file}', { file: fileName });
  return (
    <section className={`callbar is-${look}`} aria-label={t('Call with the agent')} data-testid="callbar" data-file={s.fileId ?? ''} data-look={look}>
      <button type="button" className="callbar-go" onClick={() => backToCall()} aria-label={`${back}. ${titleOf(s, look, agent, t)}. ${subOf(s, look, agent, t)}`} title={back} data-testid="callbar-back" disabled={!s.fileId}>
        <CallHead s={s} look={look} agent={agent} testIds={{ title: 'callbar-title', sub: 'callbar-sub' }} where="bar" />
      </button>
      <span className="call-live" aria-live="polite">{liveWords(s, look, agent, t)}</span>
      <span className="callbar-controls">
        {look === 'error' ? <button type="button" className="call-btn is-strong" onClick={retryCall} data-testid="callbar-retry">{t('Try again')}</button> : null}
        <MuteButton testId="callbar-mute" disabled={!live || look === 'connecting' || look === 'reconnecting'} />
        <CallMore testId="callbar-more" inBar />
        <span className="call-gap" />
        <EndButton testId="callbar-end" early={look === 'setup'} />
      </span>
    </section>
  );
}

/** A round mark for the cards that are not a live call: incoming, missed, ended. */
function CardOrb({ kind }: { kind: 'incoming' | 'missed' | 'ended' }) {
  const icon = kind === 'incoming' ? <Phone size={16} fill="currentColor" strokeWidth={0} /> : kind === 'missed' ? <PhoneMissed size={16} /> : <PhoneOff size={16} />;
  return <span className={`call-orb is-${kind}`} aria-hidden="true">{icon}</span>;
}

function callAgain(fileId: string | null, fileName: string | null): void {
  dismissEnded();
  if (fileId) void startCall({ fileId, ...(fileName ? { fileName } : {}) });
}

function EndedBar() {
  const t = useT();
  const ended = useCall((x) => x.ended);
  if (!ended) return null;
  if (ended.note.length) return <EndedNote />;
  return (
    <section className="callbar is-ended" aria-label={t('Call ended')} data-testid="callbar-ended">
      <CardOrb kind="ended" />
      <span className="call-text">
        <span className="call-status" role="status">{t('Call ended')}</span>
        <span className="call-quiet"><span className="call-sub-clock">{clock(ended.seconds)} · </span>{ended.fileName ? t('What was said is in the chat of {file}', { file: spokenName(ended.fileName) }) : t('What was said is in the chat')}</span>
      </span>
      {ended.fileId ? <button type="button" className="call-btn" onClick={() => callAgain(ended.fileId, ended.fileName)} data-testid="callbar-again">{t('Call again')}</button> : null}
      <button type="button" className="call-ib" aria-label={t('Close')} title={t('Close')} onClick={dismissEnded}><X size={16} aria-hidden="true" /></button>
    </section>
  );
}

/** The ended call with what it changed: per file, its requests, each row a way back to that file's chat. Stays until closed. */
function EndedNote() {
  const t = useT();
  const ended = useCall((x) => x.ended)!;
  const requests = ended.note.reduce((n, f) => n + f.runs.length, 0);
  const files = ended.note.length;
  // Short, so it fits beside Call again on a phone; each file's row below opens its chat, where the whole call is.
  const summary = files === 1
    ? t.n(requests, '{count} request in {file}', '{count} requests in {file}', { file: spokenName(ended.note[0]!.fileName) })
    : t.n(requests, '{count} request in {files} files', '{count} requests in {files} files', { files });
  const run = (r: CallNoteFile['runs'][number]) => {
    const what = r.title || t('A request');
    return r.status === 'stopped' ? t('{what} (not done)', { what }) : r.status === 'failed' ? t('{what} (did not work)', { what }) : r.status === 'running' ? t('{what} (still running)', { what }) : what;
  };
  return (
    <section className="callbar-card" aria-label={t('Call ended')} data-testid="callbar-ended">
      <div className="callbar-card-top">
        <CardOrb kind="ended" />
        <span className="call-text">
          <span className="call-status" role="status">{t('Call ended')}</span>
          <span className="call-quiet call-wrap"><span className="call-sub-clock">{clock(ended.seconds)} · </span>{summary}</span>
        </span>
        {ended.fileId ? <button type="button" className="call-btn" onClick={() => callAgain(ended.fileId, ended.fileName)} data-testid="callbar-again">{t('Call again')}</button> : null}
        <button type="button" className="call-ib" aria-label={t('Close')} title={t('Close')} onClick={dismissEnded}><X size={16} aria-hidden="true" /></button>
      </div>
      <ul className="callbar-files" data-testid="call-note">
        {ended.note.map((f) => (
          <li key={f.fileId}>
            <button type="button" className="callbar-file" onClick={() => { dismissEnded(); backToCall(f.fileId); }} aria-label={t('Open the chat of {file}', { file: f.fileName })}>
              <span className="call-text">
                <span className="callbar-file-name" dir="auto">{f.fileName}</span>
                <span className="call-quiet call-wrap" dir="auto">{f.runs.map(run).join(' · ')}</span>
              </span>
              <ChevronRight size={16} aria-hidden="true" className="callbar-chev" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function IncomingCard() {
  const t = useT();
  const call = useIncoming((s) => s.ringing);
  // During a live call the agent is already on the line: the card names the file that asks, not the caller.
  const inCall = useCall((s) => s.active);
  if (!call) return null;
  const agent = agentName(call.runner);
  const file = spokenName(call.fileName);
  const title = inCall ? t('{agent} has a question', { agent }) : t('{agent} is calling', { agent });
  return (
    <section className="callbar-card is-incoming" aria-label={title} data-testid="incoming-call">
      <div className="callbar-card-top">
        <CardOrb kind="incoming" />
        <span className="call-text">
          <span className="call-status">{title}</span>
          <span className="call-quiet">{inCall ? t('Working in {file}', { file }) : file}</span>
        </span>
      </div>
      <p className="callbar-question" dir="auto" aria-live="assertive">{call.question}</p>
      <div className="callbar-actions">
        <button type="button" className="call-btn is-primary" onClick={() => void answerIncoming(call)} data-testid="incoming-answer"><Phone size={14} fill="currentColor" strokeWidth={0} aria-hidden="true" />{t('Answer')}</button>
        <button type="button" className="call-btn" onClick={() => void replyInWriting(call)} data-testid="incoming-text">{t('Reply in writing')}</button>
        <button type="button" className="call-btn" onClick={() => void declineIncoming(call)} data-testid="incoming-decline">{t('Decline')}</button>
      </div>
      <RingHair from={call.at} until={call.expiresAt} />
    </section>
  );
}

function MissedBar() {
  const t = useT();
  const call = useIncoming((s) => s.missed);
  if (!call) return null;
  const agent = agentName(call.runner);
  const file = spokenName(call.fileName);
  return (
    <section className="callbar is-missed" aria-label={t('Unanswered question')} data-testid="missed-call">
      <CardOrb kind="missed" />
      <span className="call-text">
        <span className="call-status" role="status">{t('Unanswered question')}</span>
        <span className="call-quiet">{t('From {agent} in {file}', { agent, file })}</span>
      </span>
      <button type="button" className="call-btn" onClick={() => void replyInWriting(call)}>{t('Open the question')}</button>
      <button type="button" className="call-ib" aria-label={t('Close')} title={t('Close')} onClick={dismissMissed}><X size={16} aria-hidden="true" /></button>
    </section>
  );
}

/**
 * Where the dock sits: centred on the content column (the list on Home, the canvas in a file) rather than on the
 * window, and no wider than that column. At phone width the style sheet spans it across the screen instead.
 */
function placeDock(el: HTMLElement): void {
  if (innerWidth <= 520) { el.style.removeProperty('left'); el.style.removeProperty('width'); el.style.removeProperty('bottom'); return; }
  const column = document.querySelector<HTMLElement>('.home-body') ?? document.querySelector<HTMLElement>('[data-testid="canvas"]');
  const r = column?.getBoundingClientRect();
  if (!r || r.width < 360) { el.style.removeProperty('left'); el.style.removeProperty('width'); el.style.removeProperty('bottom'); return; }
  const width = Math.min(480, r.width - 32);
  const mid = r.left + r.width / 2;
  // The canvas's own chip at its foot (the map of sections) stays visible: when the centred dock would cover it,
  // the dock rises above it and stays centred.
  const chip = document.querySelector<HTMLElement>('[data-testid="canvas-map"]')?.getBoundingClientRect();
  if (chip && chip.width && chip.right > mid - width / 2 - 12 && chip.left < mid + width / 2 + 12) el.style.bottom = `${Math.round(innerHeight - chip.top + 8)}px`;
  else el.style.removeProperty('bottom');
  el.style.left = `${Math.round(mid)}px`;
  el.style.width = `${Math.round(width)}px`;
}

/**
 * The dock at the bottom of the window that holds the bar and the cards, and the pills of background work above
 * them (ActivityDock.tsx). Mounted once, above every route. While it
 * shows, the page keeps room for it at its foot (--calldock-room), so the last row of a list is never under it.
 */
export function CallDock() {
  const active = useCall((s) => s.active);
  const ended = useCall((s) => Boolean(s.ended));
  const callFile = useCall((s) => s.fileId);
  const ringing = useIncoming((s) => Boolean(s.ringing));
  const missed = useIncoming((s) => Boolean(s.missed));
  // The call's own file with the chat showing has the full call panel; the bar would only repeat it.
  const routeFile = useRouteFile();
  const panelShows = useEditor((e) => Boolean(callFile) && routeFile === callFile && e.fileId === callFile && e.prompt.open && !e.minimal);
  const phone = usePhone();
  const bar = active && (phone || !panelShows);
  // Background work (a review, pictures being made) shares the dock: its pills sit above the call.
  const activities = useVisibleActivities();
  const shows = bar || ringing || missed || (ended && !active) || activities.length > 0;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!shows || !el) { root.classList.remove('has-calldock'); root.style.removeProperty('--calldock-room'); return; }
    const measure = () => { root.style.setProperty('--calldock-room', `${Math.ceil(el.getBoundingClientRect().height) + 24}px`); };
    const place = () => placeDock(el);
    root.classList.add('has-calldock');
    measure();
    place();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // The column changes with the route and with panels opening; a cheap check each second catches what events miss.
    window.addEventListener('resize', place);
    window.addEventListener('hashchange', place);
    const every = window.setInterval(place, 1000);
    return () => {
      ro.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('hashchange', place); window.clearInterval(every);
      root.classList.remove('has-calldock'); root.style.removeProperty('--calldock-room');
    };
  }, [shows]);
  return (
    <>
      <CallSettingsHost />
      {shows ? (
        <div ref={ref} className="calldock" data-testid="calldock">
          <ActivityPills items={activities} />
          <IncomingCard />
          {missed && !ringing ? <MissedBar /> : null}
          {bar ? <ActiveBar /> : null}
          {!active && ended ? <EndedBar /> : null}
        </div>
      ) : null}
    </>
  );
}
