import { useEffect, useMemo, useState } from 'react';
import { RUNNABLE_IDS, type CommentAttachment, type CommentThread, type RunnerId } from '@bogen/core';
import { CheckCheck, ChevronRight, RotateCcw, Search, Trash2 } from 'lucide-react';
import { useComments } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { api, resolveAsset } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { rectOf } from '../canvas/measure.ts';
import { askAgentInComment, sendReply } from '../ops/comments.ts';
import { camera } from '../state/camera.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { Empty, IconButton, SelectField, TextField } from '../ui/controls.tsx';
import { VoiceNotes } from '../ui/VoiceNote.tsx';
import { prepareLayerMeasurements } from '../canvas/artboard-loading.ts';
import { CommentInput, isImageAttachment } from './CommentInput.tsx';
import { MessageFiles, ThreadRunView } from './ThreadAgent.tsx';
import { ThreadResult } from './RunResult.tsx';
import { ReplyTarget, useModelNames } from './ReplyTarget.tsx';
import {
  chosenRoute, clearDraft, conversationTitle, draftKey, getDraft, isUnread, lastPreview, markSeen, seenAt, targetLabel, useDraft, useTargets, visibleMessages, visibleThreads,
  type ReplyTarget as Target, type ThreadFilter,
} from './conversation-state.ts';
import { msg } from '../i18n/core.ts';
import { formatDate } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import '../styles/conversations.css';

/** Targets come from the server; they change when a request is accepted or a run ends. */
const loadTargets = (fileId: string) => api.commentTargets(fileId);
const refreshTargets = (fn: () => void) => onServerEvent((e) => { if (e.t === 'comment-run' && e.status !== 'working') fn(); });

export function useReplyTargets(fileId: string | null): Record<string, Target> {
  return useTargets(fileId, loadTargets, refreshTargets);
}

export function timeAgo(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t.n(Math.floor(s / 60), '{count}m ago', '{count}m ago');
  if (s < 86400) return t.n(Math.floor(s / 3600), '{count}h ago', '{count}h ago');
  return formatDate(at, {});
}


/** Mentions stand out, so that it is clear who was asked. */
export function MessageText({ text }: { text: string }) {
  const parts = text.split(/((?:^|(?<=\s))@[\w.-]+)/);
  return <>{parts.map((part, i) => (i % 2 ? <strong key={i} className="message-mention">{part}</strong> : part))}</>;
}

/** Only images this server holds are shown: what is in a message came from someone else's document. */
function MessageImages({ files }: { files: CommentAttachment[] }) {
  const t = useT();
  const images = files.filter((f) => typeof f?.src === 'string' && isImageAttachment(f.src)).map((f) => ({ src: resolveAsset(f.src), name: f.name }));
  if (!images.length) return null;
  return (
    <div className="message-files">
      {images.map((img, i) => (
        <button key={i} type="button" className="message-file" aria-label={img.name ? t('Open {name}', { name: img.name }) : t('Open the attached image')} data-testid="message-image" onClick={(e) => { e.stopPropagation(); ui().set({ lightbox: { images, index: i } }); }}>
          <img src={img.src} alt={img.name ?? ''} />
        </button>
      ))}
    </div>
  );
}

const CHECK_LABEL: Record<string, string> = { brand: msg('Brand'), lint: msg('Lint'), widths: msg('Widths'), practice: msg('Practice') };

/** The runner to hand a fix to: the one that made the suggestion, which may carry a model in its name. */
function fixRunner(by: string): RunnerId {
  const named = RUNNABLE_IDS.find((id) => new RegExp(`^${id}\\b`, 'i').test(by));
  return named ?? 'claude';
}

/** A suggestion an agent left with its note, such as in a critique, and a fix run in one click. */
function ThreadSuggestion({ thread }: { thread: CommentThread }) {
  const t = useT();
  const run = useEditor((s) => s.threadRuns[thread.id]);
  const suggestion = thread.suggestion!;
  const runner = fixRunner(suggestion.by);
  const fix = async () => {
    try {
      // A reply that asks the agent: the comment run gets the thread, the layer and this suggestion.
      await askAgentInComment(`@${runner} Fix this as suggested: ${suggestion.text}`, { threadId: thread.id });
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  return (
    <div className="thread-suggestion" data-testid="thread-suggestion" onClick={(e) => e.stopPropagation()}>
      <div className="thread-suggestion-text" dir="auto">{t('Suggestion: {text}', { text: suggestion.text })}</div>
      <div className="thread-suggestion-row">
        {!thread.resolved && !run ? <button type="button" className="run-link" onClick={() => void fix()} data-testid="thread-fix">{t('Fix it')}</button> : null}
        {suggestion.check ? <span className="thread-check">{CHECK_LABEL[suggestion.check] ? t(CHECK_LABEL[suggestion.check]!) : suggestion.check}</span> : null}
      </div>
    </div>
  );
}

/** Over the notes of the latest critique: who wrote them, and that nothing was changed. */
function CritiqueHead({ threads }: { threads: CommentThread[] }) {
  const t = useT();
  const open = threads.filter((th) => th.suggestion && !th.resolved);
  if (!open.length) return null;
  const latest = open.reduce((a, b) => ((b.messages[0]?.at ?? 0) > (a.messages[0]?.at ?? 0) ? b : a));
  const run = latest.suggestion!.run;
  const same = open.filter((th) => th.suggestion!.run === run);
  return (
    <div className="critique-head" data-testid="critique-head">
      <strong>{run ? t('Critique by {name}', { name: latest.suggestion!.by }) : t('Suggestions by {name}', { name: latest.suggestion!.by })}</strong>
      <span>{t.n(same.length, '{count} open note · each with a fix you can hand back in one click', '{count} open notes · each with a fix you can hand back in one click')}</span>
    </div>
  );
}

/** Brings a thread's pin into view and selects its layer. */
function jumpTo(thread: CommentThread): void {
  const s = session();
  const state = editor();
  if (thread.pageId !== state.pageId) state.set({ pageId: thread.pageId, selection: [] });
  state.set({ activeThreadId: thread.id });
  if (thread.nodeId) prepareLayerMeasurements([thread.nodeId]);
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (editor().fileId !== s.fileId || editor().activeThreadId !== thread.id) return;
    const r = thread.nodeId ? rectOf(thread.nodeId) : null;
    const x = (r?.x ?? 0) + thread.x;
    const y = (r?.y ?? 0) + thread.y;
    const c = camera.value;
    camera.set({ ...c, x: camera.width / 2 - x * c.z, y: camera.height / 2 - y * c.z }, false);
    if (thread.nodeId) state.set({ selection: [thread.nodeId] });
  }));
}

/** Moves focus between conversation headers with the arrow keys, Home and End. */
function headerKeys(e: React.KeyboardEvent<HTMLButtonElement>, thread: CommentThread): void {
  const heads = [...document.querySelectorAll<HTMLButtonElement>('[data-testid="thread-head"]')];
  const i = heads.indexOf(e.currentTarget);
  const go = (j: number) => heads[Math.max(0, Math.min(heads.length - 1, j))]?.focus();
  if (e.key === 'ArrowDown') go(i + 1);
  else if (e.key === 'ArrowUp') go(i - 1);
  else if (e.key === 'Home') go(0);
  else if (e.key === 'End') go(heads.length - 1);
  else if (e.key === 'r') session().doc.setThreadResolved(thread.id, !thread.resolved);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

/**
 * The Comments tab: each thread is a conversation with a compact header (title, newest message, who it goes to,
 * whether an agent works on it, news). One is open at a time, with its messages and composer; the canvas pin and
 * the queue open the same one. A click on the open header closes it again.
 */
export function CommentsPanel() {
  const t = useT();
  const threads = useComments();
  const pageId = useEditor((s) => s.pageId);
  const active = useEditor((s) => s.activeThreadId);
  const fileId = useEditor((s) => s.fileId);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ThreadFilter>('open');
  const targets = useReplyTargets(fileId);
  // A thread opened from outside the list (a pin, the queue, a notification, the tab opening) shows even where the
  // search or filter would hide it. Changing the search or filter is the person's own choice, and then it applies.
  const [revealed, setRevealed] = useState<string | null>(active);
  useEffect(() => setRevealed(active), [active]);
  const search = (q: string) => { setQuery(q); setRevealed(null); };
  const choose = (f: ThreadFilter) => { setFilter(f); setRevealed(null); };
  const list = useMemo(() => visibleThreads(threads, { query, filter, pageId, active: revealed }), [threads, query, filter, pageId, revealed]);

  // A pin or a notification opens a thread: bring it into view in the list.
  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => document.querySelector(`.conversations [data-thread="${CSS.escape(active)}"]`)?.scrollIntoView({ block: 'nearest' }));
  }, [active]);

  const toggle = (thread: CommentThread) => {
    if (active === thread.id) editor().set({ activeThreadId: null });
    else jumpTo(thread);
  };

  return (
    <div className="comments conversations" data-testid="comments-panel">
      <div className="comments-head">
        <TextField label={<Search size={14} />} value={query} onChange={search} placeholder={t('Search comments')} live testId="comments-search" />
        <SelectField<ThreadFilter> value={filter} onChange={choose} options={[{ value: 'open', label: t('Open') }, { value: 'resolved', label: t('Resolved') }, { value: 'page', label: t('This page') }, { value: 'all', label: t('All') }]} testId="comments-filter" title={t('Filter')} />
      </div>
      {!threads.length ? <Empty title={t('No comments yet')} hint={t('Press {key} and click anywhere on the canvas. Mention @claude or @codex to ask that agent, on your own plan. Replies then go to the same agent.', { key: 'C' })} /> : null}
      {threads.length > 0 && !list.length ? <Empty title={t('Nothing here')} hint={t('No comment matches this search or filter.')} /> : null}
      <CritiqueHead threads={threads} />
      <div className="threads" role="list" aria-label={t('Conversations')}>
        {list.map(({ thread, outside }) => <Conversation key={thread.id} thread={thread} open={thread.id === active} outside={outside} target={targets[thread.id]} fileId={fileId ?? ''} onToggle={() => toggle(thread)} />)}
      </div>
    </div>
  );
}

function Conversation({ thread, open, outside, target, fileId, onToggle }: { thread: CommentThread; open: boolean; outside: boolean; target: Target | undefined; fileId: string; onToggle: () => void }) {
  const t = useT();
  const s = session();
  const me = s.user.name;
  const run = useEditor((st) => st.threadRuns[thread.id]);
  const names = useModelNames();
  const key = draftKey(fileId, thread.id);
  const ownDraft = useDraft(key);
  const [showAll, setShowAll] = useState(false);
  const last = lastPreview(thread);
  // Opened is seen. The mark is per browser, and only a convenience.
  useEffect(() => { if (open && fileId) markSeen(fileId, thread.id, Math.max(Date.now(), last?.at ?? 0)); }, [open, fileId, thread.id, last?.at]);
  const unread = !open && fileId ? isUnread(thread, me, seenAt(fileId, thread.id)) : false;
  const draft = !open && Boolean(ownDraft && (ownDraft.text.trim() || ownDraft.files.length));
  const { hidden, shown } = visibleMessages(thread.messages, showAll);
  const headId = `conv-head-${thread.id}`;
  const bodyId = `conv-body-${thread.id}`;
  const status = run ? (run.status === 'working' ? t('{runner} working', { runner: run.runner }) : t('{runner} waiting', { runner: run.runner })) : null;
  return (
    <article
      className={`thread conv${open ? ' is-active is-open' : ''}${thread.resolved ? ' is-resolved' : ''}${unread ? ' is-unread' : ''}`}
      data-testid="thread"
      data-thread={thread.id}
      data-open={open ? '' : undefined}
      data-outside={outside ? '' : undefined}
      role="listitem"
    >
      <h3 className="conv-h">
        <button
          type="button"
          id={headId}
          className="conv-head"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          onKeyDown={(e) => headerKeys(e, thread)}
          data-testid="thread-head"
        >
          <ChevronRight size={13} className="conv-caret" aria-hidden="true" />
          <span className="conv-title" dir="auto" data-testid="thread-title">{conversationTitle(thread)}</span>
          <span className="conv-meta">
            {unread ? <span className="conv-unread" data-testid="thread-unread"><span className="conv-dot" aria-hidden="true" />{t('New')}</span> : null}
            {status ? <span className={`conv-state is-${run!.status}`} data-testid="thread-state">{status}</span> : null}
            {draft ? <span className="conv-draft" data-testid="thread-draft">{t('Draft')}</span> : null}
            {thread.resolved ? <span className="conv-resolved">{t('Resolved')}</span> : null}
            <span className="conv-time">{last ? timeAgo(last.at) : ''}</span>
          </span>
          {target ? <span className="conv-target" data-testid="thread-target">{targetLabel(target, names)}</span> : null}
          {!open && last ? <span className="conv-preview" dir="auto" data-testid="thread-preview">{t.rich('{author}: {message}', { author: <b>{last.author === me ? t('You') : last.author}</b>, message: last.text })}</span> : null}
        </button>
      </h3>
      {outside ? <p className="conv-outside" data-testid="thread-outside">{t('Opened directly. Your search or filter would hide it otherwise.')}</p> : null}
      {open ? (
        <div className="conv-body" id={bodyId} role="region" aria-labelledby={headId}>
          {hidden ? <button type="button" className="conv-earlier run-link" onClick={() => setShowAll(true)} data-testid="thread-earlier">{t.n(hidden, 'Show {count} earlier message', 'Show {count} earlier messages')}</button> : null}
          {shown.map((m) => (
            <div key={m.id} className={`message${m.by === 'agent' ? ' is-agent' : m.by === 'system' ? ' is-system' : ''}`}>
              <div className="message-head"><strong dir="auto">{m.author}</strong><span>{timeAgo(m.at)}</span></div>
              <div className="message-text" dir="auto"><MessageText text={m.text} /></div>
              {m.attachments?.length ? <MessageImages files={m.attachments} /> : null}
              {m.attachments?.length ? <MessageFiles files={m.attachments} /> : null}
              {m.attachments?.length ? <VoiceNotes files={m.attachments} /> : null}
            </div>
          ))}
          {thread.suggestion ? <ThreadSuggestion thread={thread} /> : null}
          <ThreadRunView threadId={thread.id} />
          {s.fileId ? <ThreadResult fileId={s.fileId} threadId={thread.id} /> : null}
          <Reply key={key} threadId={thread.id} draftKey={key} target={target} />
          <div className="thread-actions">
            <IconButton icon={thread.resolved ? <RotateCcw size={13} /> : <CheckCheck size={13} />} title={thread.resolved ? t('Reopen') : t('Resolve')} onClick={(e) => { e.stopPropagation(); s.doc.setThreadResolved(thread.id, !thread.resolved); }} testId="thread-resolve" />
            <IconButton icon={<Trash2 size={13} />} title={t('Delete thread')} onClick={(e) => { e.stopPropagation(); clearDraft(key); s.doc.deleteThread(thread.id); }} testId="thread-delete" />
          </div>
        </div>
      ) : null}
    </article>
  );
}

function Reply({ threadId, draftKey: key, target }: { threadId: string; draftKey: string; target: Target | undefined }) {
  const t = useT();
  const draft = useDraft(key);
  const [text, setText] = useState(draft?.text ?? '');
  const route = chosenRoute(text, draft, target);
  const send = async (body: string, files: CommentAttachment[]) => {
    // The choice as it is at the moment of sending, with what was typed.
    await sendReply(threadId, body, files, chosenRoute(body, getDraft(key), target));
    clearDraft(key);
  };
  return (
    <div className="reply" onClick={(e) => e.stopPropagation()}>
      <CommentInput
        placeholder={target ? t('Reply') : t('Reply, or ask @claude or @codex')}
        testId="thread-reply" sendTestId="thread-send" focusKey={threadId} draftKey={key} onText={setText} onSubmit={send}
        onCancel={() => { (document.querySelector(`[data-thread="${CSS.escape(threadId)}"] [data-testid="thread-head"]`) as HTMLElement | null)?.focus(); }}
      />
      <ReplyTarget route={route} draftKey={key} inherited={target} />
    </div>
  );
}
