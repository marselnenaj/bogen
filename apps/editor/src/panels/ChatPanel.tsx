import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy, Images, Layers, Loader2, MessageSquarePlus, PanelRightClose, Paperclip, Pencil, Plus, RotateCcw, Square, X } from 'lucide-react';
import { isRunnerId, MAX_DIRECTION_LANES, LANE_COLORS, inferIntent, type RunIntent, type RunLanguageChoice } from '@bogen/core';
import { api, resolveAsset, type ConversationSummary, type Runner } from '../lib/api.ts';
import type { LaneChoice, RunnerCatalog } from '../lib/agent-api.ts';
import { collabApi, type RemoteRunner } from '../lib/collab-api.ts';
import { conversationFor } from '../lib/conversation.ts';
import { onServerEvent } from '../lib/events.ts';
import { camera } from '../state/camera.ts';
import type { ChatChrome } from '../state/chrome-layout.ts';
import { useSettings } from '../state/settings.ts';
import { editor, useEditor, type PromptMessage } from '../state/store.ts';
import { session } from '../doc/session.ts';
import { IconButton, SelectField } from '../ui/controls.tsx';
import { Markdown } from '../ui/Markdown.tsx';
import { MicButton, useVoice, VoiceNotice, VoiceRecording } from '../ui/VoiceInput.tsx';
import { joinWords } from '../ui/voice-state.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { shortAgo } from '../phone/phone-api.ts';
import { addImages, atBottom, chatTurns, clampChatWidth, contextChips, elapsed, lastUserMessage, MAX_CHAT_IMAGES, replyText, type ChatTurn } from './chat-state.ts';
import { stepLines } from './collab-words.ts';
import { effectiveLanguage, LanguageChoice, languageNote, useBrandVoice, useFileLanguage } from './ContentLanguage.tsx';
import { CHAT_FOCUS_EVENT, newChat, openChat, rebuildStoredImage, restoreChat, sendPrompt, setChatOpen, startRace, stopPrompt } from './prompt-actions.ts';
import { screenRedoPrompt } from './redo-screen.ts';
import { RunChoice, runnerName, useRunnerCatalogs, useRunSettings } from './RunChoice.tsx';
import { RunResult } from './RunResult.tsx';

/**
 * The chat with an agent, one per file, docked beside the canvas (or over it in a narrow window). It runs the
 * person's own CLI through the server; no keys live here. The conversation is kept on the server per file
 * (conversations.ts), so each message reaches a fresh CLI with what was said before, whichever CLI answered.
 * This is the former prompt bar, with everything it did: the review modes, the runner and model, races,
 * proposals, critiques, the redo of a screen, the design language, and an image pasted to rebuild as layers.
 */

type Review = 'direct' | 'proposal' | 'directions' | 'critique';
const REVIEW_KEY = 'bogen-prompt-review';
const RUNNER_KEY = 'bogen-prompt-runner';
const LANES_KEY = 'bogen-prompt-lanes';
const MAX_LANES = MAX_DIRECTION_LANES;

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // It lasts for this tab then.
  }
}

function storedLanes(): LaneChoice[] {
  try {
    const parsed: unknown = JSON.parse(stored(LANES_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((l): l is LaneChoice => typeof l?.runner === 'string').slice(0, MAX_LANES) : [];
  } catch {
    return [];
  }
}

/** Three lanes to start with: both CLIs when there are two, with the model each uses for the prompt. */
function defaultLanes(available: string[]): LaneChoice[] {
  if (!available.length) return [];
  const order = available.length > 1 ? [available[0]!, available[1]!, available[0]!] : [available[0]!, available[0]!, available[0]!];
  return order.map((runner) => ({ runner }));
}

/** Runners on paired devices, as choices: "Claude Code on PC". */
function remoteOptions(offers: RemoteRunner[]): { value: string; label: string }[] {
  return offers.flatMap((o) => o.runners.filter((r) => r.available).map((r) => ({ value: `${r.id}@${o.deviceId}`, label: t('{runner} on {device}', { runner: runnerName(r.id), device: o.device }) })));
}

const REVIEW_WORDS: Record<Review, string> = { direct: msg('Change it'), proposal: msg('Propose'), directions: msg('Directions'), critique: msg('Critique') };

/** How a message was asked, in words: a review mode the server keeps (proposal, critique, directions), or Change it. */
function reviewWords(review: string | undefined): string {
  return t(REVIEW_WORDS[(review ?? 'direct') as Review] ?? REVIEW_WORDS.direct);
}

/** Who answered, in words: a runner's id as its name, a name already given (on another device) as it is. */
function whoWords(runner: string | undefined): string {
  if (!runner) return t('Agent');
  return isRunnerId(runner) ? runnerName(runner) : runner;
}

/** Who races: a runner and a model per lane, two to sixteen lanes. */
function RaceLanes({ lanes, onChange, runners, catalogs }: { lanes: LaneChoice[]; onChange: (lanes: LaneChoice[]) => void; runners: Runner[]; catalogs: Record<string, RunnerCatalog> | undefined }) {
  const t = useT();
  const available = runners.filter((r) => r.available);
  // The prompt's own model picker is hidden for a race, so the lanes ask for their runners' catalogs themselves.
  useRunnerCatalogs(lanes.map((l) => l.runner));
  const update = (i: number, patch: Partial<LaneChoice>) => onChange(lanes.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="prompt-race-settings">
      <div className="prompt-lane-count">
        <span>{t('Runs')}</span>
        <SelectField value={String(lanes.length)} options={Array.from({ length: MAX_LANES - 1 }, (_, i) => ({ value: String(i + 2), label: String(i + 2) }))} title={t('Runs')} testId="prompt-lane-count" onChange={(value) => {
          const count = Number(value);
          onChange(Array.from({ length: count }, (_, i) => lanes[i] ?? { runner: available[i % available.length]?.id ?? runners[0]?.id ?? 'claude' }));
        }} />
      </div>
      <div className="prompt-lanes" data-testid="prompt-lanes">
        {lanes.map((lane, i) => {
          const models = catalogs?.[lane.runner]?.models ?? [];
          return (
            <span key={i} className="prompt-lane" data-testid="prompt-lane">
              <span className="lane-index" aria-hidden="true">{i + 1}</span>
              <span className="lane-dot" style={{ '--lane': LANE_COLORS[i % LANE_COLORS.length] } as React.CSSProperties} />
              <SelectField className="prompt-lane-runner" value={lane.runner} options={available.map((r) => ({ value: r.id, label: runnerName(r.id) }))} onChange={(runner) => update(i, { runner, model: undefined })} title={t('Which CLI runs this lane')} testId="prompt-lane-runner" />
              <SelectField className="prompt-lane-model" value={lane.model ?? ''} options={[{ value: '', label: t('Its model') }, ...models.map((m) => ({ value: m.id, label: m.label }))]} onChange={(model) => update(i, { model: model || undefined })} title={t('Model for this lane. Its model is what the prompt uses for this runner.')} testId="prompt-lane-model" />
              {lanes.length > 2 ? <IconButton icon={<X size={11} />} title={t('Take this lane out')} onClick={() => onChange(lanes.filter((_, j) => j !== i))} testId="prompt-lane-remove" /> : null}
            </span>
          );
        })}
        {lanes.length < MAX_LANES && available.length ? <button type="button" className="run-link" onClick={() => onChange([...lanes, { runner: available[0]!.id }])} data-testid="prompt-lane-add"><Plus size={11} /> {t('Runner')}</button> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- where the panel sits

/** Drags the chat's left edge. Its width is in UI pixels, kept with the other panels'. */
function ChatResizer() {
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const start = editor().chatWidth;
    const uiScale = useSettings.getState().uiScale;
    const move = (ev: PointerEvent) => editor().set({ chatWidth: clampChatWidth(start - (ev.clientX - startX) / uiScale) });
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      camera.measureViewport();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const t = useT();
  return (
    <div
      className="resizer resizer-right" role="separator" aria-orientation="vertical" aria-label={t('Chat width')} tabIndex={0}
      onPointerDown={onDown}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        editor().set({ chatWidth: clampChatWidth(editor().chatWidth + (e.key === 'ArrowLeft' ? 16 : -16)) });
      }}
      data-testid="resizer-chat"
    />
  );
}

/**
 * Where the chat lives: one element for the editor's life, so what is being written survives docking, a drawer
 * and closing. Docked, it is a column between the canvas and the inspector; as a drawer it lies over the canvas at
 * its right edge, and Esc closes it.
 */
export function ChatHost({ lay, minimal }: { lay: ChatChrome; minimal: boolean }) {
  const open = useEditor((s) => s.prompt.open);
  const docked = !minimal && open && lay.chat === 'docked';
  const drawer = !minimal && open && lay.chat === 'drawer';
  const shown = docked || drawer;
  useEffect(() => {
    const f = requestAnimationFrame(() => camera.measureViewport());
    return () => cancelAnimationFrame(f);
  }, [docked, drawer, lay.chatPx]);
  return (
    <div
      className={drawer ? 'panel-slot panel-drawer is-right chat-slot is-drawer' : 'panel-slot chat-slot'}
      style={drawer ? { width: lay.chatPx, right: lay.right === 'docked' && !minimal ? lay.rightPx : 0 } : undefined}
      hidden={!shown}
      inert={!shown}
      data-testid="chat-slot"
      data-dock={docked ? 'docked' : drawer ? 'drawer' : 'closed'}
      onKeyDown={drawer ? (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        setChatOpen(false);
        requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="prompt-toggle"]')?.focus());
      } : undefined}
    >
      {docked ? <ChatResizer /> : null}
      <ChatPanel drawer={drawer} />
    </div>
  );
}

// ---------------------------------------------------------------- the panel

export function ChatPanel({ drawer = false }: { drawer?: boolean }) {
  const t = useT();
  const prompt = useEditor((s) => s.prompt);
  const fileId = useEditor((s) => s.fileId);
  const selection = useEditor((s) => s.selection);
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [remote, setRemote] = useState<RemoteRunner[]>([]);
  const [runner, setRunnerState] = useState('');
  const [storedReview, setReviewState] = useState<Review>((stored(REVIEW_KEY) as Review | null) ?? 'direct');
  const review = prompt.redo ? 'direct' : storedReview;
  const [lanes, setLanesState] = useState<LaneChoice[]>(storedLanes);
  const [lastReview, setLastReview] = useState<Review | null>(null);
  // What the request means for the existing design, read as the person types; one click overrides it for this message.
  const [intentOverride, setIntentOverride] = useState<RunIntent | null>(null);
  // The design content language for this one request, over the file's. Choosing it starts nothing; Send does.
  const [language, setLanguage] = useState<RunLanguageChoice>({});
  const [dragging, setDragging] = useState(false);
  const fileLanguage = useFileLanguage();
  const brandVoice = useBrandVoice(prompt.open ? fileId : null);
  const settings = useRunSettings();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const setLanes = (next: LaneChoice[]) => {
    setLanesState(next);
    remember(LANES_KEY, JSON.stringify(next));
  };
  const setRunner = (id: string) => {
    setRunnerState(id);
    remember(RUNNER_KEY, id);
  };
  const setReview = (value: Review) => {
    setReviewState(value);
    remember(REVIEW_KEY, value);
  };
  const focusInput = useCallback(() => requestAnimationFrame(() => inputRef.current?.focus()), []);
  const voice = useVoice({ use: 'chat', onText: (words) => setText((current) => joinWords(current, words)), onDone: focusInput });

  // Who can run this, here and on paired devices that allow this one: asked when the chat opens, and again each
  // time it is asked to take the focus, since a device may have allowed it meanwhile.
  const loadRunners = useCallback(() => {
    void collabApi.remoteRunners().then((offers) => {
      setRemote(offers);
      const saved = stored(RUNNER_KEY);
      if (saved?.includes('@') && remoteOptions(offers).some((o) => o.value === saved)) setRunnerState((r) => r || saved);
    }, () => setRemote([]));
    api.runners().then((list) => {
      setRunners(list);
      const saved = stored(RUNNER_KEY);
      setRunnerState((r) => r || (list.some((x) => x.id === saved && x.available) ? saved! : list.find((x) => x.available)?.id) || '');
      const available = list.filter((x) => x.available).map((x) => x.id);
      setLanesState((current) => (current.length >= 2 && current.every((l) => available.includes(l.runner)) ? current : defaultLanes(available)));
    }).catch(() => setRunners([]));
  }, []);

  useEffect(() => {
    const focus = () => {
      setView('chat');
      inputRef.current?.focus();
      loadRunners();
    };
    window.addEventListener(CHAT_FOCUS_EVENT, focus);
    return () => window.removeEventListener(CHAT_FOCUS_EVENT, focus);
  }, [loadRunners]);
  useEffect(() => { if (!prompt.redo) return; setText(''); setIntentOverride('revise'); setLanguage({}); inputRef.current?.focus(); }, [prompt.redo?.id]);

  // What is selected goes with the message, as it changes; a chip taken out stays out until the selection changes.
  useEffect(() => {
    const st = editor();
    if (!st.prompt.open || st.prompt.redo || st.prompt.running) return;
    if (st.prompt.nodeIds.join() !== selection.join()) st.set({ prompt: { ...st.prompt, nodeIds: selection } });
  }, [selection]);

  useEffect(() => {
    if (!prompt.open) return;
    void restoreChat();
    loadRunners();
  }, [prompt.open, fileId, loadRunners]);

  // A mode with no language left to apply it to (the file default was cleared meanwhile) goes back to plain writing.
  const anyLanguage = Boolean(effectiveLanguage(language, fileLanguage, brandVoice));
  useEffect(() => {
    if (!anyLanguage && language.mode) setLanguage({});
  }, [anyLanguage, language.mode]);

  // A new file starts with an empty field.
  useEffect(() => {
    setText('');
    setImages([]);
    setView('chat');
  }, [fileId]);

  const available = runners?.filter((r) => r.available) ?? [];
  const elsewhere = remoteOptions(remote);
  const none = runners !== null && !available.length && !elsewhere.length;
  // A runner on another device is "claude@<device id>".
  const [runnerId = '', deviceId] = runner.split('@');
  const deviceName = deviceId ? remote.find((r) => r.deviceId === deviceId)?.device : undefined;

  const { snap } = session();
  const target = prompt.nodeIds.filter((id) => snap.nodes.has(id));
  // A race works on one layer: the selected one, or the only artboard on the page.
  const pageTop = prompt.open ? snap.children(editor().pageId ?? '') : [];
  const raceTarget = target.length === 1 ? target[0] : !target.length && pageTop.length === 1 ? pageTop[0] : undefined;
  // The same reading the server makes: a redo of existing work goes into a revision, a new page only when asked for.
  const inferred = inferIntent(text);
  // A translation changes the layers in place; a language version is a branch the server opens. Neither is a redo.
  const languageMode = language.mode ?? 'write';
  const intent: RunIntent = prompt.redo ? 'revise' : intentOverride ?? (languageMode !== 'write' ? 'edit' : inferred === 'revise' && !pageTop.length ? 'edit' : inferred);
  const lang = effectiveLanguage(language, fileLanguage, brandVoice);
  const languageLine = languageNote(language, lang);
  const chosenLanguage = language.tag || language.mode ? language : undefined;
  const names = target.map((id) => ({ id, name: snap.nodes.get(id)?.name ?? id }));
  const runnerLabel = runnerName(runnerId || runner);

  const submit = (override?: string) => {
    const typed = override ?? text;
    const v = prompt.redo ? screenRedoPrompt(typed) : typed.trim() || (review === 'critique' ? 'Critique this.' : images.length ? 'Look at the image.' : '');
    if (!v || !runner || prompt.running || uploading) return;
    if (prompt.redo) {
      const doc = session().doc;
      if (!doc.getNode(prompt.redo.nodeId)?.artboard || doc.pageOf(prompt.redo.nodeId) !== editor().pageId) {
        editor().set({ prompt: { ...editor().prompt, redo: undefined } });
        editor().showToast(t('Nothing selected'));
        return;
      }
    }
    // Never quietly a translation of the original: a version needs the branch only Change it makes.
    if (languageMode === 'add' && review !== 'direct') return void editor().showToast(t('Needs Change it: the version is a branch of the whole design.'));
    voice.dismiss();
    if (review === 'directions') {
      if (!raceTarget) return void editor().showToast(t('Select the one layer the directions are for.'));
      if (lanes.length < 2) return void editor().showToast(t('A race needs at least two runners.'));
      if (override === undefined) setText('');
      setLastReview(review);
      setLanguage({});
      void startRace(v, raceTarget, lanes, chosenLanguage);
      return;
    }
    if (override === undefined) setText('');
    const sentImages = images;
    setImages([]);
    setLastReview(review);
    setIntentOverride(null);
    setLanguage({});
    // On another device, that device's own choice for the prompt applies.
    const { model, effort } = deviceId ? {} : settings?.settings.runners[runnerId]?.prompt ?? {};
    const redo = prompt.redo;
    if (redo) {
      // A new explicit screen request must not resume another screen's draft from the previous chat.
      newChat();
      setReview('direct');
      editor().set({ prompt: { ...editor().prompt, redo: undefined } });
    }
    void sendPrompt(v, runnerId, {
      ...(model ? { model } : {}), ...(effort ? { effort } : {}),
      ...(review !== 'direct' ? { review } : languageMode === 'add' ? {} : { intent }),
      ...(deviceId ? { device: deviceId } : {}), ...(chosenLanguage ? { language: chosenLanguage } : {}),
      ...(sentImages.length ? { images: sentImages } : {}),
    }, { context: names.map((n) => n.name), runnerLabel: deviceName ? t('{runner} on {device}', { runner: runnerLabel, device: deviceName }) : runnerId, review });
  };

  const attach = async (files: File[]) => {
    const pictures = files.filter((f) => f.type.startsWith('image/'));
    if (!pictures.length) return void editor().showToast(t('Only images go with a message here. Attach other files to a comment.'));
    for (const file of pictures) {
      setUploading((n) => n + 1);
      try {
        const asset = await api.upload(file);
        setImages((current) => {
          const { images: next, dropped } = addImages(current, [asset.src]);
          if (dropped) editor().showToast(t.n(MAX_CHAT_IMAGES, 'At most {count} image goes with a message.', 'At most {count} images go with a message.'));
          return next;
        });
      } catch (err) {
        editor().showToast(t('Could not add the image. {error}', { error: (err as Error).message }));
      } finally {
        setUploading((n) => n - 1);
      }
    }
    inputRef.current?.focus();
  };

  const editLast = () => {
    const last = lastUserMessage(prompt.messages);
    if (!last) return;
    setText(last.text);
    focusInput();
  };

  if (!prompt.open) return <section className="chat" data-testid="prompt-closed" hidden />;

  const intentNote = review !== 'direct' || (!text.trim() && !prompt.redo) || (languageMode !== 'write' && !intentOverride) ? null : intent === 'revise'
    ? { say: t('Redo: goes into a revision next to the original, to accept or discard.'), other: t('Change it in place'), to: 'edit' as const }
    : intent === 'new_page' ? { say: t('Makes a new page.'), other: t('Not a new page'), to: 'edit' as const }
    : intentOverride === 'edit' && inferred !== 'edit' ? { say: t('Changes the existing layers in place.'), other: inferred === 'revise' ? t('Redo as a revision') : t('Make a new page'), to: inferred } : null;

  const label = target.length === 1 ? names[0]!.name : target.length ? t.n(target.length, '{count} layer', '{count} layers') : t('This page');
  const cost = review === 'directions'
    ? ` · ${t.n(lanes.length, '{count} run, each on your own plan', '{count} runs, each on your own plan')}`
    : deviceId ? ` · ${deviceName ? t('runs on {device}, its plan, and comes back by sync', { device: deviceName }) : t('runs on another device, its plan, and comes back by sync')}` : '';
  const modeLine = review === 'proposal' ? t('Changes go into a copy next to {target}. You accept or discard it.', { target: label })
    : review === 'critique' ? t('Notes as comments on {target}. Nothing changes.', { target: label })
    : review === 'directions' ? t('Several runs, each in its own copy of {target}, side by side.', { target: label })
    : null;
  const showNotes = lastReview === 'critique' && !prompt.running && prompt.messages.length > 0;
  const placeholder = none
    ? t('Install {claude} or {codex} to use this', { claude: 'claude', codex: 'codex' })
    : prompt.running ? t('{agent} is working. Stop it, or wait for its answer.', { agent: runnerLabel })
    : review === 'critique'
      ? target.length ? t('What to look at in {target}, or just {key}', { target: label, key: 'Enter' }) : t('What to look at in this page, or just {key}', { key: 'Enter' })
      : target.length ? t('Ask about {target}', { target: label }) : t('Ask about this page');
  const canSend = Boolean(text.trim() || images.length || review === 'critique' || prompt.redo) && Boolean(runner) && !uploading;
  const title = prompt.messages.find((m) => m.role === 'user')?.text.replace(/\s+/g, ' ').trim();

  return (
    <section
      className={`chat${dragging ? ' is-dropping' : ''}`}
      data-ui
      data-testid="prompt"
      aria-label={t('Chat with your agent')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(e) => {
        setDragging(false);
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        void attach(files);
      }}
    >
      {view === 'history' ? (
        <ChatHistory fileId={fileId} running={prompt.running} onBack={() => setView('chat')} onPick={(id) => { void openChat(id).then(() => { setView('chat'); focusInput(); }); }} onNew={() => { newChat(); setView('chat'); focusInput(); }} />
      ) : (
        <>
          <header className="chat-head">
            <button type="button" className="chat-title" onClick={() => setView('history')} title={t('Earlier chats in this file')} data-testid="chat-title">
              <span dir="auto">{title || t('New chat')}</span>
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <IconButton icon={<MessageSquarePlus size={14} />} title={t('New chat: the agent forgets what was said here')} onClick={() => { newChat(); focusInput(); }} disabled={prompt.running || !prompt.messages.length} testId="prompt-new-chat" />
            <IconButton icon={<RotateCcwClock />} title={t('Earlier chats in this file')} onClick={() => setView('history')} testId="chat-history-open" />
            <IconButton icon={<PanelRightClose size={14} />} title={drawer ? t('Close ({shortcut})', { shortcut: 'Esc' }) : t('Hide the chat ({shortcut})', { shortcut: 'Ctrl+Alt+3' })} onClick={() => setChatOpen(false)} testId="chat-close" />
          </header>
          {prompt.redo ? <div className="prompt-redo" data-testid="prompt-redo"><strong>{t('Redo this screen…')} {prompt.redo.name}</strong><button type="button" className="run-link" onClick={() => { editor().set({ prompt: { ...editor().prompt, redo: undefined } }); setIntentOverride(null); setText(''); }}>{t('Cancel')}</button></div> : null}
          <ChatLog
            messages={prompt.messages}
            running={prompt.running}
            runId={prompt.runId}
            fileId={fileId}
            onRetry={() => { const last = lastUserMessage(prompt.messages); if (last) submit(last.text); }}
            onEdit={editLast}
          />
          {showNotes ? <div className="prompt-notes"><button type="button" className="run-link" onClick={() => editor().set({ rightTab: 'comments' })} data-testid="prompt-show-notes">{t('Show the notes')}</button></div> : null}
          <footer className="chat-composer">
            {review === 'directions' && runners?.length ? <RaceLanes lanes={lanes} onChange={setLanes} runners={runners} catalogs={settings?.catalogs} /> : null}
            <div className={`chat-box${voice.phase === 'recording' ? ' is-recording' : ''}`}>
              {names.length || images.length || uploading ? (
                <div className="chat-context" data-testid="chat-context">
                  <ContextChips names={names} />
                  {images.map((src) => (
                    <span key={src} className="chat-image" data-testid="chat-image">
                      <img src={resolveAsset(src)} alt={t('Attached image')} />
                      <span className="chat-image-actions">
                        <button type="button" title={t('Rebuild as layers')} aria-label={t('Rebuild as layers')} onClick={() => { setImages((list) => list.filter((s) => s !== src)); const note = text.trim(); setText(''); void rebuildStoredImage(src, note, runner); }}><Layers size={10} /></button>
                        <button type="button" title={t('Remove')} aria-label={t('Remove the image')} onClick={() => setImages((list) => list.filter((s) => s !== src))} data-testid="chat-image-remove"><X size={10} /></button>
                      </span>
                    </span>
                  ))}
                  {uploading ? <span className="chat-image is-busy" role="status" aria-label={t('Uploading')}><Loader2 size={12} className="spin" /></span> : null}
                </div>
              ) : null}
              <textarea
                ref={inputRef}
                rows={2}
                className="prompt-input chat-input"
                value={text}
                data-testid="prompt-input"
                aria-label={placeholder}
                placeholder={voice.phase === 'transcribing' ? t('Writing it out') : placeholder}
                dir="auto"
                disabled={none}
                onChange={(e) => {
                  setText(e.target.value);
                  if (!e.target.value.trim()) setIntentOverride(null);
                }}
                onPaste={(e) => {
                  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
                  if (!files.length || none) return;
                  e.preventDefault();
                  void attach(files);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    submit();
                  }
                  // Up in an empty field takes back the last message to edit, as chats do.
                  if (e.key === 'ArrowUp' && !text && !prompt.running) {
                    const last = lastUserMessage(prompt.messages);
                    if (last) { e.preventDefault(); setText(last.text); }
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    if (drawer) {
                      setChatOpen(false);
                      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="prompt-toggle"]')?.focus());
                      return;
                    }
                    if (prompt.redo) editor().set({ prompt: { ...prompt, redo: undefined } });
                    else (document.querySelector<HTMLElement>('main.stage') ?? document.body).focus?.();
                    inputRef.current?.blur();
                  }
                }}
              />
              {voice.phase === 'recording' ? <VoiceRecording voice={voice} testId="chat-mic" /> : (
                <div className="chat-controls">
                  <IconButton icon={<Paperclip size={14} />} title={t('Attach an image, or paste or drop one here')} onClick={() => pickImages((files) => void attach(files))} disabled={none} testId="chat-attach" />
                  {runners?.length && review !== 'directions' ? (
                    <SelectField className="prompt-runner" value={runner} options={[...runners.map((r) => ({ value: r.id, label: r.available ? runnerName(r.id) : r.reason && (r.installed || r.checked) ? t('{runner} (not available)', { runner: runnerName(r.id) }) : t('{runner} (not found)', { runner: runnerName(r.id) }), disabled: !r.available })), ...elsewhere]} onChange={setRunner} testId="prompt-runner" title={t('Which CLI runs this, here or on a paired device that allows it')} />
                  ) : null}
                  {runner && !deviceId && review !== 'directions' ? <RunChoice runner={runner} scope="prompt" testId="prompt-choice" /> : null}
                  <SelectField<Review> disabled={Boolean(prompt.redo)} className="prompt-review" value={review} options={[{ value: 'direct', label: t('Change it') }, { value: 'proposal', label: t('Propose') }, { value: 'directions', label: t.n(lanes.length || 3, '{count} direction', '{count} directions') }, { value: 'critique', label: t('Critique') }]} onChange={setReview} testId="prompt-review" title={t('Change the layers, work in copies you accept or discard, race several runs, or only get comments')} />
                  <span className="chat-controls-end">
                  <LanguageChoice
                    value={language}
                    onChange={setLanguage}
                    canAdd={review === 'direct' && !prompt.redo}
                    brand={brandVoice}
                    selection={target.length > 0}
                    onInstruction={(line) => {
                      setText((current) => (current.trim() ? `${current.trimEnd()} ${line}` : line));
                      inputRef.current?.focus();
                    }}
                  />
                  {prompt.running ? null : <MicButton voice={voice} testId="chat-mic" />}
                  {prompt.running ? (
                    <button type="button" className="chat-stop prompt-stop" onClick={stopPrompt} data-testid="prompt-stop" title={t('Stop')}>
                      <Square size={9} fill="currentColor" aria-hidden="true" />
                      <span className="chat-stop-time" aria-hidden="true"><Elapsed since={prompt.startedAt} /></span>
                      {t('Stop')}
                    </button>
                  ) : (
                    <IconButton className="prompt-send" icon={<ArrowUp size={14} />} title={review === 'directions' ? t.n(lanes.length, 'Start {count} run', 'Start {count} runs') : t('Send ({shortcut})', { shortcut: 'Enter' })} disabled={!canSend} onClick={() => submit()} testId="prompt-send" />
                  )}
                  </span>
                </div>
              )}
            </div>
            <VoiceNotice voice={voice} testId="chat" />
            {languageLine ? (
              <div className="prompt-language-note" role="status" data-testid="prompt-language-note" data-mode={languageMode}>
                <span>{languageLine}</span>
                <button type="button" className="run-link" onClick={() => setLanguage({})} data-testid="prompt-language-reset">{t('Reset')}</button>
              </div>
            ) : null}
            {intentNote ? (
              <div className="prompt-intent" role="status" data-testid="prompt-intent" data-intent={intent}>
                <span>{intentNote.say}</span>
                {!prompt.redo ? <button type="button" className="run-link" onClick={() => setIntentOverride(intentNote.to)} data-testid="prompt-intent-switch">{intentNote.other}</button> : null}
              </div>
            ) : null}
            <p className="prompt-target chat-target" data-testid="prompt-target">{modeLine ?? label}{cost}</p>
          </footer>
        </>
      )}
      {dragging ? <div className="chat-drop" aria-hidden="true"><Images size={16} /> {t('Drop an image to send it with the message')}</div> : null}
    </section>
  );
}

function RotateCcwClock() {
  // Lucide's history icon (rotate-ccw-clock), by its own name.
  return <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>;
}

function pickImages(onPicked: (files: File[]) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.onchange = () => onPicked([...(input.files ?? [])]);
  input.click();
}

function Elapsed({ since }: { since: number | undefined }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>{since ? elapsed(now - since) : ''}</>;
}

/** The layers that go with the message, each one taken out with its cross. */
function ContextChips({ names }: { names: { id: string; name: string }[] }) {
  const t = useT();
  const { shown, more } = contextChips(names);
  const drop = (ids: string[]) => {
    const st = editor();
    st.set({ prompt: { ...st.prompt, nodeIds: st.prompt.nodeIds.filter((id) => !ids.includes(id)) } });
  };
  return (
    <>
      {shown.map((n) => (
        <span key={n.id} className="chat-chip" data-testid="chat-chip">
          <Layers size={11} aria-hidden="true" />
          <span dir="auto">{n.name}</span>
          <button type="button" title={t('Leave {name} out of the message', { name: n.name })} aria-label={t('Leave {name} out of the message', { name: n.name })} onClick={() => drop([n.id])} data-testid="chat-chip-remove"><X size={10} /></button>
        </span>
      ))}
      {more ? (
        <span className="chat-chip is-more">
          {t.n(more, 'and {count} more', 'and {count} more')}
          <button type="button" title={t('Leave them out of the message')} aria-label={t('Leave them out of the message')} onClick={() => drop(names.slice(3).map((n) => n.id))}><X size={10} /></button>
        </span>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- the conversation

function ChatLog({ messages, running, runId, fileId, onRetry, onEdit }: { messages: PromptMessage[]; running: boolean; runId: string | null; fileId: string | null; onRetry: () => void; onEdit: () => void }) {
  const t = useT();
  const listRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [behind, setBehind] = useState(false);
  const turns = chatTurns(messages);
  const hasMessages = messages.length > 0;

  // New words keep the list at its end, unless the person scrolled up to read; then it stays and says there is more.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setBehind(true);
  }, [messages]);
  // What arrives later under a reply (the layers it changed, a picture of them) keeps the end in view too.
  useEffect(() => {
    const el = listRef.current;
    const inner = innerRef.current;
    if (!el || !inner || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (stick.current) el.scrollTop = el.scrollHeight; });
    observer.observe(inner);
    return () => observer.disconnect();
  }, [hasMessages]);
  // A chat opened again starts at its end.
  useEffect(() => { stick.current = true; }, [fileId]);

  if (!messages.length) return <ChatEmpty />;
  return (
    <div className="chat-log-wrap">
      <div
        ref={listRef}
        className="chat-log prompt-messages"
        data-testid="prompt-messages"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-busy={running}
        tabIndex={0}
        onScroll={(e) => {
          stick.current = atBottom(e.currentTarget);
          if (stick.current) setBehind(false);
        }}
      >
        <div ref={innerRef} className="chat-log-inner">
          {turns.map((turn, i) => <Turn key={turn.index >= 0 ? turn.index : `a${i}`} turn={turn} last={i === turns.length - 1} running={running && i === turns.length - 1} liveRunId={runId} fileId={fileId} onRetry={onRetry} onEdit={onEdit} />)}
        </div>
      </div>
      {behind ? (
        <button type="button" className="chat-jump" onClick={() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight; stick.current = true; setBehind(false); }} data-testid="chat-jump">
          <ArrowDown size={12} /> {t('Jump to the latest')}
        </button>
      ) : null}
    </div>
  );
}

function ChatEmpty() {
  const t = useT();
  return (
    <div className="chat-empty" data-testid="chat-empty">
      <h2>{t('Ask your agent about this page')}</h2>
      <p>{t('It works on what you select, or on the whole page. The chat stays with this file, and the next message knows what was said.')}</p>
      <dl>
        <dt>{t('Change it')}</dt><dd>{t('Edits the layers. Undo takes the whole run back.')}</dd>
        <dt>{t('Propose')}</dt><dd>{t('Works in a copy you accept or discard.')}</dd>
        <dt>{t('Directions')}</dt><dd>{t('Several runs, each in its own copy, side by side.')}</dd>
        <dt>{t('Critique')}</dt><dd>{t('Notes as comments. Nothing changes.')}</dd>
      </dl>
      <p className="chat-keys">{t('Enter sends, Shift+Enter adds a line. {shortcut} shows or hides the chat.', { shortcut: 'Ctrl+Alt+3' })}</p>
    </div>
  );
}

function Turn({ turn, last, running, liveRunId, fileId, onRetry, onEdit }: { turn: ChatTurn; last: boolean; running: boolean; liveRunId: string | null; fileId: string | null; onRetry: () => void; onEdit: () => void }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const words = replyText(turn);
  const steps = stepLines(turn.steps.map((tool) => ({ tool })), running ? 6 : 40);
  const done = !running;
  // What a run changed goes under its words, once it is over.
  const result = done && turn.runId && fileId && liveRunId !== turn.runId;
  const copy = () => {
    void navigator.clipboard?.writeText(words).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => editor().showToast(t('Could not copy.')));
  };
  return (
    <div className="chat-turn" data-testid="chat-turn">
      {turn.user ? (
        <div className="chat-you" data-testid="chat-you">
          {turn.user.context?.length || turn.user.images?.length ? (
            <div className="chat-you-context">
              {turn.user.context?.slice(0, 3).map((name, i) => <span key={i} className="chat-chip is-static"><Layers size={11} aria-hidden="true" /><span dir="auto">{name}</span></span>)}
              {(turn.user.context?.length ?? 0) > 3 ? <span className="chat-chip is-static">{t.n((turn.user.context?.length ?? 0) - 3, 'and {count} more', 'and {count} more')}</span> : null}
              {turn.user.images?.map((src) => <img key={src} className="chat-you-image" src={resolveAsset(src)} alt={t('Attached image')} />)}
            </div>
          ) : null}
          <p className="prompt-msg is-user chat-bubble" dir="auto">{turn.user.text}</p>
        </div>
      ) : null}
      {turn.replies.length || turn.steps.length || turn.error || running || turn.notes.length ? (
        <div className="chat-agent" data-testid="chat-agent">
          <div className="chat-who">
            <span className="chat-who-dot" aria-hidden="true" />
            <span className="chat-who-name">{whoWords(turn.user?.runner)}</span>
            {turn.user ? <span>{reviewWords(turn.user.review)}</span> : null}
            {turn.user?.at ? <span className="chat-who-at">{shortAgo(turn.user.at)}</span> : null}
          </div>
          {words ? <Markdown text={words} className="md prompt-msg is-agent" /> : null}
          {running ? (
            <ol className="chat-steps" aria-live="polite" data-testid="chat-steps">
              {steps.map((s, i) => (
                <li key={i} className={i === steps.length - 1 ? 'is-current' : ''}>
                  {i === steps.length - 1 ? <Loader2 size={12} className="spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
                  <span>{s.text}{s.count > 1 ? ` (${s.count})` : ''}</span>
                </li>
              ))}
              {!steps.length ? <li className="is-current"><Loader2 size={12} className="spin" aria-hidden="true" /><span>{t('Working')}</span></li> : null}
            </ol>
          ) : steps.length ? (
            <div className="chat-steps-done">
              <button type="button" className="chat-steps-toggle" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="chat-steps-toggle">
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {t.n(turn.steps.length, '{count} step', '{count} steps')}
              </button>
              {open ? <ol className="chat-steps is-done">{steps.map((s, i) => <li key={i}><Check size={12} aria-hidden="true" /><span>{s.text}{s.count > 1 ? ` (${s.count})` : ''}</span></li>)}</ol> : null}
            </div>
          ) : null}
          {turn.notes.map((n, i) => <p key={i} className="chat-note" data-testid="chat-note">{n.text}</p>)}
          {turn.error ? (
            <div className="chat-error prompt-msg is-error" role="alert" data-testid="chat-error">
              <p><CircleAlert size={13} aria-hidden="true" /> <span dir="auto">{turn.error.text}</span></p>
              {last && turn.user ? (
                <div className="chat-error-actions">
                  <button type="button" className="chat-pill" onClick={onRetry} data-testid="chat-retry"><RotateCcw size={12} /> {t('Try again')}</button>
                  <button type="button" className="run-link" onClick={onEdit}>{t('Edit the message')}</button>
                </div>
              ) : null}
            </div>
          ) : null}
          {result ? <RunResult fileId={fileId!} runId={turn.runId!} /> : null}
          {done && (words || last) && !turn.error ? (
            <div className="chat-actions">
              {words ? <IconButton icon={copied ? <Check size={13} /> : <Copy size={13} />} title={copied ? t('Copied') : t('Copy the answer')} onClick={copy} testId="chat-copy" /> : null}
              {last && turn.user ? <IconButton icon={<RotateCcw size={13} />} title={t('Ask again')} onClick={onRetry} testId="chat-ask-again" /> : null}
              {last && turn.user ? <IconButton icon={<Pencil size={13} />} title={t('Edit your message')} onClick={onEdit} testId="chat-edit" /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- earlier chats

function ChatHistory({ fileId, running, onBack, onPick, onNew }: { fileId: string | null; running: boolean; onBack: () => void; onPick: (id: string) => void; onNew: () => void }) {
  const t = useT();
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const current = fileId ? conversationFor(fileId) : '';
  useEffect(() => {
    if (!fileId) return;
    let live = true;
    const load = () => void api.conversations(fileId).then((l) => { if (live) setList(l); }, () => { if (live) setList([]); });
    load();
    const off = onServerEvent((e) => { if (e.t === 'run-history' && e.fileId === fileId) load(); });
    return () => {
      live = false;
      off();
    };
  }, [fileId]);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus(); }, []);
  return (
    <div className="chat-history" data-testid="chat-history" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onBack(); } }}>
      <header className="chat-head">
        <button ref={back} type="button" className="icon-btn" title={t('Back to the chat')} aria-label={t('Back to the chat')} onClick={onBack} data-testid="chat-history-back"><ChevronLeft size={14} /></button>
        <h2 className="chat-head-title">{t('Chats in this file')}</h2>
        <button type="button" className="chat-pill is-quiet" onClick={onNew} disabled={running} data-testid="chat-history-new"><Plus size={13} /> {t('New chat')}</button>
      </header>
      {list === null ? <p className="chat-history-note">{t('Loading')}</p> : !list.length ? <p className="chat-history-note">{t('No chats in this file yet.')}</p> : (
        <ul className="chat-history-list" aria-label={t('Chats in this file')}>
          {list.map((c) => (
            <li key={c.id}>
              <button type="button" className={`chat-history-row${c.id === current ? ' is-current' : ''}`} aria-current={c.id === current ? 'true' : undefined} disabled={running && c.id !== current} onClick={() => (c.id === current ? onBack() : onPick(c.id))} data-testid="chat-history-row">
                <span className="chat-history-top">
                  <span className="chat-history-title" dir="auto">{c.title || t('New chat')}</span>
                  {c.id === current ? <span className="chat-history-open">{t('Open')}</span> : null}
                </span>
                <span className="chat-history-meta">{[c.runners.map(runnerName).join(', '), t.n(c.turns, '{count} message', '{count} messages'), shortAgo(c.updatedAt)].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="chat-history-note">{running ? t('A run is going. Its chat stays open until it is done.') : t('Each chat starts the agent fresh with what was said in it. This file keeps its last 40.')}</p>
    </div>
  );
}
