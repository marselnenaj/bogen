import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp, ChevronLeft, ImagePlus, Mic, X } from 'lucide-react';
import { agentMentions, isRunnerId, type CommentAttachment, type CommentThread } from '@bogen/core';
import { rectOf } from '../canvas/measure.ts';
import { useComments } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { api, resolveAsset } from '../lib/api.ts';
import { PhotoChip, usePhotoPicker } from './PhotoSheet.tsx';
import type { Photo } from './photo.ts';
import { askAgentInComment, sendReply } from '../ops/comments.ts';
import { chosenRoute, clearDraft, conversationTitle, draftKey, getDraft, isUnread, lastPreview, markSeen, seenAt, setDraft, targetLabel, useDraft, visibleMessages } from '../panels/conversation-state.ts';
import { useReplyTargets } from '../panels/Conversations.tsx';
import { ReplyTarget, useModelNames } from '../panels/ReplyTarget.tsx';
import { camera } from '../state/camera.ts';
import { editor, useEditor } from '../state/store.ts';
import { animateCamera } from './board-view.ts';
import { runnerName, shortAgo } from './phone-api.ts';
import { Sheet } from './Sheet.tsx';
import { stepLines, stopThreadRun } from '../panels/ThreadAgent.tsx';
import { ThreadResult } from '../panels/RunResult.tsx';
import { toolWords } from '../panels/collab-words.ts';
import { canRecord, dropRecording, MAX_RECORD_SECONDS, sendRecording, startRecording, voiceStatus, type Recording, type VoiceStatus } from './voice.ts';
import { clockOf, VoiceNotes } from '../ui/VoiceNote.tsx';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

/** Mentions in blue, so that it is clear who was asked. */
function MessageText({ text }: { text: string }) {
  const parts = text.split(/((?:^|(?<=\s))@[\w.-]+)/);
  return <>{parts.map((part, i) => (i % 2 ? <b key={i} className="pf-mention">{part}</b> : part))}</>;
}

function author(name: string, me: string): string {
  if (name === me) return t('You');
  return isRunnerId(name) ? runnerName(name) : name;
}

/** The line under the field before anything is recorded: that the keyboard can dictate, and where a recording goes. */
function voiceHint(status: VoiceStatus | null, recordable: boolean): string {
  if (!recordable) return t('Dictate with the microphone on the keyboard.');
  if (status?.transcriber) return t('Record a voice note, written out on {device}, or dictate with the microphone on the keyboard.', { device: status.device });
  return t('Record a voice note for your computer, or dictate with the microphone on the keyboard.');
}

/**
 * The field at the bottom: Enter or the arrow sends. Mentions of agents go to the computer, as on the desktop.
 * The microphone records a voice note for the computer, which writes it out into the field when it has a local
 * model, and otherwise keeps it as an attachment. The keyboard's own dictation works in the field as always.
 */
function Composer({ placeholder, onSend, autoFocus, testId, draftKey: key, onText, extra }: { placeholder: string; onSend: (text: string, attachments: CommentAttachment[]) => Promise<void>; autoFocus?: boolean; testId: string; draftKey?: string; onText?: (text: string) => void; extra?: ReactNode }) {
  const t = useT();
  // A reply being written stays with its thread while the app is open. Photos and recordings stay only while the sheet is.
  const [text, setText] = useState(() => (key ? getDraft(key)?.text ?? '' : ''));
  useEffect(() => {
    if (key) setDraft(key, { text });
    onText?.(text);
  }, [key, text]);
  const [busy, setBusy] = useState(false);
  const [voice, setVoice] = useState<CommentAttachment | null>(null);
  const [photo, setPhoto] = useState<Photo | null>(null);
  const picker = usePhotoPicker(setPhoto);
  const [note, setNote] = useState<string | null>(null);
  const [rec, setRec] = useState<'idle' | 'recording' | 'sending'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>([]);
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const recording = useRef<Recording | null>(null);
  const unsent = useRef<CommentAttachment | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const recordable = canRecord();

  useEffect(() => {
    let live = true;
    if (recordable) void voiceStatus().then((s) => { if (live) setStatus(s); });
    return () => {
      live = false;
      // A recording nobody sent does not stay on the computer.
      recording.current?.cancel();
      if (unsent.current) dropRecording(unsent.current);
    };
  }, [recordable]);

  useEffect(() => {
    if (rec !== 'recording') return;
    const since = performance.now();
    setSeconds(0);
    const timer = setInterval(() => setSeconds((performance.now() - since) / 1000), 250);
    return () => clearInterval(timer);
  }, [rec]);

  // The field grows with what is in it, a transcript included, up to a few lines.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(168, Math.max(48, el.scrollHeight + 4))}px`;
  }, [text, rec]);

  const dictate = (why: string) => {
    setNote(why);
    field.current?.focus();
  };

  const stop = async () => {
    const r = recording.current;
    const fileId = editor().fileId;
    if (!r || !fileId) return;
    recording.current = null;
    setRec('sending');
    try {
      const { blob, seconds: length } = await r.stop();
      const out = await sendRecording(fileId, blob, length);
      if (out.transcript !== null) {
        const words = out.transcript;
        setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${words}` : words));
        setNote(t('Written out on {device} with {transcriber}. The recording is deleted. Edit the text before you send it.', { device: out.device, transcriber: out.transcriber }));
      } else {
        if (unsent.current) dropRecording(unsent.current);
        unsent.current = out.attachment;
        setVoice(out.attachment);
        setNote(t('{reason} The recording is attached as a voice note, kept on {device}.', { reason: out.reason, device: out.device }));
      }
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setRec('idle');
      requestAnimationFrame(() => field.current?.focus());
    }
  };

  const record = async () => {
    if (busy || rec !== 'idle') return;
    if (!recordable || !editor().fileId) return dictate(t('This browser cannot record here. Dictate with the microphone on the keyboard instead.'));
    setNote(null);
    setLevels([]);
    try {
      recording.current = await startRecording(
        (level) => setLevels((prev) => [...prev.slice(-15), level]),
        () => void stop(),
      );
      setRec('recording');
    } catch (e) {
      const refused = (e as Error).name === 'NotAllowedError';
      dictate(refused ? t('The microphone is not allowed. Dictate with the microphone on the keyboard, or allow it for this app in Settings.') : t('No recording: {error}. Dictate with the microphone on the keyboard instead.', { error: (e as Error).message }));
    }
  };

  const cancel = () => {
    recording.current?.cancel();
    recording.current = null;
    setRec('idle');
    setNote(null);
  };

  const removeVoice = () => {
    if (voice) dropRecording(voice);
    unsent.current = null;
    setVoice(null);
    setNote(null);
  };

  const send = async () => {
    const body = text.trim() || (voice ? 'Voice note' : photo ? 'Photo' : '');
    if (!body || busy || rec !== 'idle' || picker.busy) return;
    setBusy(true);
    // Once sent, the recording belongs to the comment, and leaving the sheet no longer deletes it.
    const held = unsent.current;
    unsent.current = null;
    try {
      const files: CommentAttachment[] = [...(voice ? [voice] : []), ...(photo ? [{ src: photo.src, name: 'Photo', width: photo.width, height: photo.height, kind: 'image' as const }] : [])];
      await onSend(body, files);
      setVoice(null);
      setPhoto(null);
      setText('');
      setNote(null);
    } catch (e) {
      unsent.current = held;
      editor().showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const ready = Boolean(text.trim() || voice || photo) && !busy && rec === 'idle' && !picker.busy;
  return (
    <div className="pf-composer" data-testid={`${testId}-composer`}>
      {photo ? <PhotoChip photo={photo} onRemove={() => setPhoto(null)} testId={`${testId}-photo`} /> : null}
      {voice ? (
        <div className="pf-voice-chip" data-testid={`${testId}-voice`}>
          <span>{voice.duration !== undefined ? t('Voice note, {duration}', { duration: clockOf(voice.duration) }) : t('Voice note')}</span>
          <button type="button" onClick={removeVoice} aria-label={t('Remove the voice note')}><X size={18} strokeWidth={2.5} /></button>
        </div>
      ) : null}
      {extra}
      <form className="pf-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        {rec === 'recording' ? (
          <>
            <button type="button" className="pf-mic" onClick={cancel} aria-label={t('Cancel the recording')} data-testid={`${testId}-voice-cancel`}><X size={22} strokeWidth={2.5} /></button>
            <div className="pf-recording" role="status" data-testid={`${testId}-recording`}>
              <span className="pf-rec-dot" />
              <span className="pf-rec-time">{clockOf(seconds)}</span>
              <span className="pf-rec-meter" aria-hidden="true">{Array.from({ length: 16 }, (_, i) => <span key={i} style={{ height: `${Math.round(3 + (levels[i] ?? 0) * 15)}px` }} />)}</span>
            </div>
            <button type="button" className="pf-rec-stop" onClick={() => void stop()} data-testid={`${testId}-voice-stop`}>{t('Stop')}</button>
          </>
        ) : (
          <>
            <button type="button" className="pf-mic" onClick={() => picker.pick(false)} disabled={busy || picker.busy || rec === 'sending'} aria-label={t('Attach a photo')} data-testid={`${testId}-attach`}><ImagePlus size={22} strokeWidth={2.25} /></button>
            <button type="button" className="pf-mic" onClick={() => void record()} disabled={busy || rec === 'sending'} aria-label={recordable ? t('Record a voice note') : t('Dictate with the keyboard')} data-testid={`${testId}-mic`}><Mic size={22} strokeWidth={2.25} /></button>
            <textarea
              ref={field} className="pf-compose-input pf-compose-text" dir="auto" rows={1} value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={rec === 'sending' ? t('Sending the recording to your computer') : placeholder} aria-label={placeholder} enterKeyHint="send" autoFocus={autoFocus} data-testid={testId}
            />
            <button type="submit" className="pf-send" disabled={!ready} aria-label={t('Send')} data-testid={`${testId}-send`}><ArrowUp size={22} strokeWidth={2.5} /></button>
          </>
        )}
      </form>
      <p className="pf-compose-note" data-testid={`${testId}-voice-note`}>
        {rec === 'recording' ? t('The recording goes to your computer only. It stops by itself at {time}.', { time: clockOf(MAX_RECORD_SECONDS) })
          : rec === 'sending' ? (status?.transcriber ? t('Writing it out on {device}.', { device: status.device }) : t('Sending it to your computer.'))
          : picker.busy ? t('Sending the photo to your computer.')
          : picker.error || (note ?? voiceHint(status, recordable))}
      </p>
    </div>
  );
}

function RunLine({ threadId }: { threadId: string }) {
  const t = useT();
  const run = useEditor((s) => s.threadRuns[threadId]);
  const [stopping, setStopping] = useState(false);
  useEffect(() => setStopping(false), [run?.runId, run?.status]);
  if (!run) return null;
  const working = run.status === 'working';
  const lines = working ? stepLines(run.steps ?? [], 6) : [];
  const stop = () => {
    setStopping(true);
    void stopThreadRun(run).catch((e: Error) => {
      setStopping(false);
      editor().showToast(e.message);
    });
  };
  return (
    <div className="pf-run-box" data-testid="pf-thread-run-box">
      <p className="pf-run" data-testid="pf-thread-run">
        {stopping ? t('Stopping {runner}.', { runner: runnerName(run.runner) }) : run.status === 'queued' ? t('{runner} waits for its turn.', { runner: runnerName(run.runner) }) : run.tool ? t('{runner} is working: {tool}.', { runner: runnerName(run.runner), tool: toolWords(run.tool).toLowerCase() }) : t('{runner} is working.', { runner: runnerName(run.runner) })}
        {(working && run.runId) || (!working && run.queueId) ? <button type="button" disabled={stopping} onClick={stop} data-testid="pf-thread-run-stop">{working ? t('Stop') : t('Cancel')}</button> : null}
      </p>
      {!working && run.reason && run.reason !== 'Starting' ? <p className="pf-run-reason">{run.reason}.</p> : null}
      {lines.length ? <ol className="pf-run-steps" data-testid="pf-thread-steps">{lines.map((l, i) => <li key={i} className={i === lines.length - 1 ? 'is-now' : ''}>{l.text}{l.count > 1 ? ` (${l.count})` : ''}</li>)}</ol> : null}
    </div>
  );
}

/** Where a thread's pin is, in the world. */
function pinAt(t: CommentThread): { x: number; y: number } {
  const r = t.nodeId ? rectOf(t.nodeId) : null;
  return { x: (r?.x ?? 0) + t.x, y: (r?.y ?? 0) + t.y };
}

function openThread(t: CommentThread): void {
  const state = editor();
  if (t.pageId !== state.pageId) state.set({ pageId: t.pageId, selection: [] });
  state.set({ activeThreadId: t.id, pendingComment: null });
  requestAnimationFrame(() => {
    const p = pinAt(t);
    const c = camera.value;
    animateCamera({ ...c, x: camera.width / 2 - p.x * c.z, y: camera.height / 3 - p.y * c.z });
  });
}

function layerName(id: string | undefined): string | undefined {
  return id ? session().snap.nodes.get(id)?.name : undefined;
}

/**
 * D4: comments. A pin opens its thread; with the sheet open, a tap on the canvas places a new comment on
 * the spot or the layer under it. Replies and new comments that mention @claude or @codex start that agent
 * on the computer, exactly as they do on the desktop.
 */
export function CommentSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const threads = useComments();
  const activeId = useEditor((s) => s.activeThreadId);
  const pending = useEditor((s) => s.pendingComment);
  const pageId = useEditor((s) => s.pageId);
  const s = session();
  const me = s.user.name;
  const thread = threads.find((th) => th.id === activeId);
  const open = useMemo(() => threads.filter((th) => th.pageId === pageId && !th.resolved), [threads, pageId]);

  // Taps place a comment while this sheet is open, unless one is being written.
  useEffect(() => {
    if (!pending && editor().tool !== 'comment') editor().set({ tool: 'comment' });
  }, [pending, activeId]);

  if (pending && pageId) {
    const on = layerName(pending.nodeId);
    const send = async (body: string, files: CommentAttachment[]) => {
      const where = { pageId, ...(pending.nodeId ? { nodeId: pending.nodeId } : {}), x: pending.x, y: pending.y };
      const id = agentMentions(body).length ? await askAgentInComment(body, where, files) : s.doc.addThread({ ...where, author: me, text: body, ...(files.length ? { attachments: files } : {}) });
      editor().set({ pendingComment: null, activeThreadId: id });
    };
    return (
      <Sheet title={t('New comment')} aside={<button type="button" className="pf-link is-dim" onClick={() => editor().set({ pendingComment: null })}>{t('Cancel')}</button>} onClose={onClose} testId="pf-comment"
        foot={<Composer placeholder={t('Comment')} onSend={send} autoFocus testId="pf-comment-input" />}>
        <p className="pf-dim">{on ? t.rich('On {layer}. Mention @claude or @codex to ask that agent on the computer.', { layer: <b className="pf-ink" dir="auto">{on}</b> }) : t('Mention @claude or @codex to ask that agent on the computer.')}</p>
      </Sheet>
    );
  }

  if (thread) return <PhoneThread thread={thread} onClose={onClose} />;

  return (
    <Sheet title={t('Comments')} aside={<span className="pf-aside-text">{t.n(open.length, '{count} open', '{count} open')}</span>} onClose={onClose} testId="pf-comment">
      <p className="pf-hint" data-testid="pf-comment-hint">{t('Tap a spot or a layer to place a comment.')}</p>
      <ThreadRows threads={open} me={me} />
    </Sheet>
  );
}

/** The open conversations of the page: what each is about, its newest message, who it goes to, and news. */
function ThreadRows({ threads, me }: { threads: CommentThread[]; me: string }) {
  const t = useT();
  const fileId = useEditor((st) => st.fileId) ?? '';
  const targets = useReplyTargets(fileId || null);
  const names = useModelNames();
  const sorted = [...threads].sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
  return (
    <div className="pf-thread-list" role="list" aria-label={t('Conversations')}>
      {sorted.map((th) => <ThreadRow key={th.id} thread={th} me={me} fileId={fileId} target={targets[th.id] ? targetLabel(targets[th.id], names) : null} />)}
    </div>
  );
}

function ThreadRow({ thread, me, fileId, target }: { thread: CommentThread; me: string; fileId: string; target: string | null }) {
  const t = useT();
  const run = useEditor((st) => st.threadRuns[thread.id]);
  // Only this row hears about its own draft.
  const draft = useDraft(draftKey(fileId, thread.id));
  const last = lastPreview(thread, 90);
  const unread = fileId ? isUnread(thread, me, seenAt(fileId, thread.id)) : false;
  const writing = Boolean(draft && (draft.text.trim() || draft.files.length));
  return (
    <button type="button" role="listitem" className={`pf-thread-row${unread ? ' is-unread' : ''}`} onClick={() => openThread(thread)} data-testid="pf-thread-row" data-thread={thread.id}
      aria-label={[conversationTitle(thread), unread ? t('new messages') : '', run ? (run.status === 'working' ? t('{runner} working', { runner: runnerName(run.runner) }) : t('{runner} waiting', { runner: runnerName(run.runner) })) : '', writing ? t('draft') : ''].filter(Boolean).join(', ')}>
      <span className="pf-thread-row-head" dir="auto">{layerName(thread.nodeId) ? t.rich('{title} on {layer}', { title: <b>{conversationTitle(thread, 60)}</b>, layer: layerName(thread.nodeId)! }) : <b>{conversationTitle(thread, 60)}</b>}</span>
      {last ? <span className="pf-thread-row-text" dir="auto">{t('{author}: {message}', { author: author(last.author, me), message: last.text })}</span> : null}
      <span className="pf-thread-row-meta">
        {run ? <span className="pf-state" data-testid="pf-thread-state">{run.status === 'working' ? t('{runner} working', { runner: runnerName(run.runner) }) : t('{runner} waiting', { runner: runnerName(run.runner) })}</span> : null}
        {target ? <span data-testid="pf-thread-target">{target}</span> : null}
        {writing ? <span data-testid="pf-thread-draft">{t('Draft')}</span> : null}
        <span>{t.n(thread.messages.length, '{count} message · {time}', '{count} messages · {time}', { time: last ? shortAgo(last.at) : '' })}</span>
      </span>
    </button>
  );
}

/** One conversation: back to the list, its newest messages, and a reply that goes where the composer says. */
function PhoneThread({ thread, onClose }: { thread: CommentThread; onClose: () => void }) {
  const t = useT();
  const s = session();
  const me = s.user.name;
  const fileId = useEditor((st) => st.fileId) ?? '';
  const targets = useReplyTargets(fileId || null);
  const target = targets[thread.id];
  const key = draftKey(fileId, thread.id);
  const draft = useDraft(key);
  const [text, setText] = useState(draft?.text ?? '');
  const [showAll, setShowAll] = useState(false);
  const last = thread.messages.at(-1)?.at ?? 0;
  useEffect(() => { if (fileId) markSeen(fileId, thread.id, Math.max(Date.now(), last)); }, [fileId, thread.id, last]);
  const route = chosenRoute(text, draft, target);
  const reply = async (body: string, files: CommentAttachment[]) => {
    await sendReply(thread.id, body, files, chosenRoute(body, getDraft(key), target));
    clearDraft(key);
  };
  const { hidden, shown } = visibleMessages(thread.messages, showAll, 4);
  return (
    <Sheet
      title={layerName(thread.nodeId) ?? conversationTitle(thread, 40)}
      aside={thread.resolved
        ? <button type="button" className="pf-link" onClick={() => s.doc.setThreadResolved(thread.id, false)} data-testid="pf-reopen">{t('Reopen')}</button>
        : <button type="button" className="pf-link" onClick={() => { s.doc.setThreadResolved(thread.id, true); editor().set({ activeThreadId: null }); }} data-testid="pf-resolve">{t('Resolve')}</button>}
      onClose={onClose} testId="pf-comment"
      foot={<Composer key={key} placeholder={t('Reply')} onSend={reply} testId="pf-reply" draftKey={key} onText={setText} extra={<ReplyTarget route={route} draftKey={key} inherited={target} variant="phone" testId="pf-reply-target" />} />}
    >
      <button type="button" className="pf-link is-dim pf-all" onClick={() => editor().set({ activeThreadId: null })} data-testid="pf-back"><ChevronLeft size={16} aria-hidden="true" /> {t('All comments on this page')}</button>
        <div className="pf-messages" data-testid="pf-thread" data-thread-id={thread.id}>
          {hidden ? <button type="button" className="pf-link pf-earlier" onClick={() => setShowAll(true)} data-testid="pf-earlier">{t.n(hidden, 'Show {count} earlier message', 'Show {count} earlier messages')}</button> : null}
          {shown.map((m) => (
            <div key={m.id} className="pf-message" data-testid="pf-message">
              <p className="pf-message-head"><b dir="auto">{author(m.author, me)}</b> · {shortAgo(m.at)}</p>
              <p className="pf-message-text" dir="auto"><MessageText text={m.text} /></p>
              <VoiceNotes files={m.attachments} className="pf-voice" />
              {m.attachments?.filter((a) => a.kind !== 'audio' && a.src.startsWith('bogen-asset:')).map((a) => <img key={a.src} className="pf-message-photo" src={resolveAsset(a.src)} alt={a.name ?? t('Photo')} data-testid="pf-message-photo" />)}
            </div>
          ))}
          <RunLine threadId={thread.id} />
          <ThreadResult fileId={s.fileId} threadId={thread.id} variant="phone" />
        </div>
    </Sheet>
  );
}
