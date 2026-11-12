import { screenRedoPrompt } from './redo-screen.ts';
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, MessageSquarePlus, Plus, Square, X } from 'lucide-react';
import { api, type Runner } from '../lib/api.ts';
import type { LaneChoice, RunnerCatalog } from '../lib/agent-api.ts';
import { camera } from '../state/camera.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton, SelectField } from '../ui/controls.tsx';
import { rectOf } from '../canvas/measure.ts';
import { unionRects } from '../canvas/geometry.ts';
import { newChat, pasteImageToRebuild, restoreChat, sendPrompt, startRace, stopPrompt } from './prompt-actions.ts';
import { session } from '../doc/session.ts';
import { RunChoice, runnerName, useRunnerCatalogs, useRunSettings } from './RunChoice.tsx';
import { RunResult } from './RunResult.tsx';
import { collabApi, type RemoteRunner } from '../lib/collab-api.ts';
import { MAX_DIRECTION_LANES, LANE_COLORS, inferIntent, type RunIntent, type RunLanguageChoice } from '@bogen/core';
import { effectiveLanguage, LanguageChoice, languageNote, useBrandVoice, useFileLanguage } from './ContentLanguage.tsx';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

type Review = 'direct' | 'proposal' | 'directions' | 'critique';
const REVIEW_KEY = 'bogen-prompt-review';
const RUNNER_KEY = 'bogen-prompt-runner';
const LANES_KEY = 'bogen-prompt-lanes';
const MAX_LANES = MAX_DIRECTION_LANES;

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

/** Runners on paired devices, as choices: "Claude Code on PC". */
function remoteOptions(offers: RemoteRunner[]): { value: string; label: string }[] {
  return offers.flatMap((o) => o.runners.filter((r) => r.available).map((r) => ({ value: `${r.id}@${o.deviceId}`, label: t('{runner} on {device}', { runner: runnerName(r.id), device: o.device }) })));
}

/** The prompt on the canvas. It runs the user's own CLI through the server; no keys live here. */
export function PromptBar() {
  const t = useT();
  const prompt = useEditor((s) => s.prompt);
  const fileId = useEditor((s) => s.fileId);
  const [text, setText] = useState('');
  const [runners, setRunners] = useState<Runner[] | null>(null);
  const [remote, setRemote] = useState<RemoteRunner[]>([]);
  const [runner, setRunnerState] = useState('');
  const [storedReview, setReviewState] = useState<Review>((stored(REVIEW_KEY) as Review | null) ?? 'direct');
  const review=prompt.redo?'direct':storedReview;
  const [lanes, setLanesState] = useState<LaneChoice[]>(storedLanes);
  const [lastReview, setLastReview] = useState<Review | null>(null);
  // What the request means for the existing design, read as the person types; one click overrides it for this message.
  const [intentOverride, setIntentOverride] = useState<RunIntent | null>(null);
  // The design content language for this one request, over the file's. Choosing it starts nothing; Send does.
  const [language, setLanguage] = useState<RunLanguageChoice>({});
  const fileLanguage = useFileLanguage();
  const brandVoice = useBrandVoice(prompt.open ? fileId : null);
  const settings = useRunSettings();
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(()=>{if(!prompt.redo)return;setText('');setIntentOverride('revise');setLanguage({});inputRef.current?.focus();},[prompt.redo?.id]);

  useEffect(() => {
    if (!prompt.open) return;
    inputRef.current?.focus();
    void restoreChat();
    // Agents on paired devices that allow this one: the CLI need not be here.
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
  }, [prompt.open]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [prompt.messages]);

  // A mode with no language left to apply it to (the file default was cleared meanwhile) goes back to plain writing.
  const anyLanguage = Boolean(effectiveLanguage(language, fileLanguage, brandVoice));
  useEffect(() => {
    if (!anyLanguage && language.mode) setLanguage({});
  }, [anyLanguage, language.mode]);

  if (!prompt.open) return null;
  const available = runners?.filter((r) => r.available) ?? [];
  const elsewhere = remoteOptions(remote);
  const none = runners !== null && !available.length && !elsewhere.length;
  // A runner on another device is "claude@<device id>".
  const [runnerId = '', deviceId] = runner.split('@');
  const deviceName = deviceId ? remote.find((r) => r.deviceId === deviceId)?.device : undefined;

  const { snap } = session();
  const target = prompt.nodeIds.filter((id) => snap.nodes.has(id));
  const box = unionRects(target.flatMap((id) => rectOf(id) ?? []));
  let style: React.CSSProperties = { left: '50%', bottom: 24, transform: 'translateX(-50%)' };
  if (box) {
    const c = camera.value;
    const x = (box.x + box.w / 2) * c.z + c.x;
    const y = (box.y + box.h) * c.z + c.y + 16;
    const maxY = camera.height - 180;
    if (x > 240 && x < camera.width - 240 && y < maxY && y > 0) style = { left: x, top: y, transform: 'translateX(-50%)' };
  }

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
  const submit = () => {
    const v = prompt.redo ? screenRedoPrompt(text) : text.trim() || (review === 'critique' ? 'Critique this.' : '');
    if (!v || !runner || prompt.running) return;
    if (prompt.redo) {
      const doc=session().doc;
      if(!doc.getNode(prompt.redo.nodeId)?.artboard||doc.pageOf(prompt.redo.nodeId)!==editor().pageId){
        editor().set({prompt:{...editor().prompt,open:false,redo:undefined}});
        editor().showToast(t('Nothing selected'));
        return;
      }
    }
    // Never quietly a translation of the original: a version needs the branch only Change it makes.
    if (languageMode === 'add' && review !== 'direct') return void editor().showToast(t('Needs Change it: the version is a branch of the whole design.'));
    if (review === 'directions') {
      if (!raceTarget) return void editor().showToast(t('Select the one layer the directions are for.'));
      if (lanes.length < 2) return void editor().showToast(t('A race needs at least two runners.'));
      setText('');
      setLastReview(review);
      setLanguage({});
      void startRace(v, raceTarget, lanes, chosenLanguage);
      return;
    }
    setText('');
    setLastReview(review);
    setIntentOverride(null);
    setLanguage({});
    // On another device, that device's own choice for the prompt applies.
    const { model, effort } = deviceId ? {} : settings?.settings.runners[runnerId]?.prompt ?? {};
    const redo=prompt.redo;
    if(redo){
      // A new explicit screen request must not resume another screen's draft from the previous chat.
      newChat();
      setReview('direct');
      editor().set({prompt:{...editor().prompt,redo:undefined}});
    }
    void sendPrompt(v, runnerId, { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(review !== 'direct' ? { review } : languageMode === 'add' ? {} : { intent }), ...(deviceId ? { device: deviceId } : {}), ...(chosenLanguage ? { language: chosenLanguage } : {}) });
  };
  const intentNote = review !== 'direct' || (!text.trim()&&!prompt.redo) || (languageMode !== 'write' && !intentOverride) ? null : intent === 'revise'
    ? { say: t('Redo: goes into a revision next to the original, to accept or discard.'), other: t('Change it in place'), to: 'edit' as const }
    : intent === 'new_page' ? { say: t('Makes a new page.'), other: t('Not a new page'), to: 'edit' as const }
    : intentOverride === 'edit' && inferred !== 'edit' ? { say: t('Changes the existing layers in place.'), other: inferred === 'revise' ? t('Redo as a revision') : t('Make a new page'), to: inferred } : null;

  const label = target.length === 1 ? snap.nodes.get(target[0]!)?.name : target.length ? t.n(target.length, '{count} layer', '{count} layers') : t('This page');
  const cost = review === 'directions'
    ? ` · ${t.n(lanes.length, '{count} run, each on your own plan', '{count} runs, each on your own plan')}`
    : deviceId ? ` · ${deviceName ? t('runs on {device}, its plan, and comes back by sync', { device: deviceName }) : t('runs on another device, its plan, and comes back by sync')}` : '';
  const showNotes = lastReview === 'critique' && !prompt.running && prompt.messages.length > 0;

  return (
    <div className="prompt" data-ui style={style} data-testid="prompt">
      {prompt.redo?<div className="prompt-redo" data-testid="prompt-redo"><strong>{t('Redo this screen…')} {prompt.redo.name}</strong><button type="button" className="run-link" onClick={()=>{editor().set({prompt:{...editor().prompt,open:false,redo:undefined}});setIntentOverride(null);setText('');}}>{t('Cancel')}</button></div>:null}
      {prompt.messages.length ? (
        <div ref={listRef} className="prompt-messages" data-testid="prompt-messages">
          {prompt.messages.map((m, i) => {
            // What a run changed goes under its last words, once it is over.
            const result = m.role === 'agent' && m.runId && fileId && !(prompt.running && prompt.runId === m.runId) && !prompt.messages.slice(i + 1).some((n) => n.runId === m.runId);
            return (
              <div key={i} className="prompt-turn">
                <div className={`prompt-msg is-${m.role}`} dir="auto">{m.text}</div>
                {result ? <RunResult fileId={fileId} runId={m.runId!} /> : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {showNotes ? <div className="prompt-notes"><button type="button" className="run-link" onClick={() => editor().set({ rightTab: 'comments' })} data-testid="prompt-show-notes">{t('Show the notes')}</button></div> : null}
      {review === 'directions' && runners?.length ? <RaceLanes lanes={lanes} onChange={setLanes} runners={runners} catalogs={settings?.catalogs} /> : null}
      <div className="prompt-input-row">
        <textarea
          ref={inputRef}
          rows={1}
          className="prompt-input"
          value={text}
          data-testid="prompt-input"
          placeholder={none
            ? t('Install {claude} or {codex} to use this', { claude: 'claude', codex: 'codex' })
            : review === 'critique'
              ? target.length ? t('What to look at in {target}, or just {key}', { target: label ?? '', key: 'Enter' }) : t('What to look at in this page, or just {key}', { key: 'Enter' })
              : target.length ? t('Ask about {target}', { target: label ?? '' }) : t('Ask about this page')}
          dir="auto"
          disabled={none}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) setIntentOverride(null);
          }}
          onPaste={(e) => {
            // A pasted image lands on the canvas and is rebuilt as layers next to it, with what was typed as a note.
            const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
            if (!file || prompt.running || none) return;
            e.preventDefault();
            const note = text.trim();
            setText('');
            void pasteImageToRebuild(file, note, runner);
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === 'Escape') editor().set({ prompt: { ...prompt, open: false, redo:undefined } });
          }}
        />
        <LanguageChoice
          value={language}
          onChange={setLanguage}
          canAdd={review === 'direct'&&!prompt.redo}
          brand={brandVoice}
          selection={target.length > 0}
          onInstruction={(line) => {
            setText((current) => (current.trim() ? `${current.trimEnd()} ${line}` : line));
            inputRef.current?.focus();
          }}
        />
        {prompt.running ? (
          <IconButton className="prompt-stop" icon={<Square size={12} />} title={t('Stop')} onClick={stopPrompt} testId="prompt-stop" />
        ) : (
          <IconButton className="prompt-send" icon={<ArrowUp size={14} />} title={review === 'directions' ? t.n(lanes.length, 'Start {count} run', 'Start {count} runs') : t('Send')} disabled={(!text.trim() && review !== 'critique'&&!prompt.redo) || !runner} onClick={submit} testId="prompt-send" />
        )}
      </div>
      {languageLine ? (
        <div className="prompt-language-note" role="status" data-testid="prompt-language-note" data-mode={languageMode}>
          <span>{languageLine}</span>
          <button type="button" className="run-link" onClick={() => setLanguage({})} data-testid="prompt-language-reset">{t('Reset')}</button>
        </div>
      ) : null}
      {intentNote ? (
        <div className="prompt-intent" role="status" data-testid="prompt-intent" data-intent={intent}>
          <span>{intentNote.say}</span>
          {!prompt.redo?<button type="button" className="run-link" onClick={() => setIntentOverride(intentNote.to)} data-testid="prompt-intent-switch">{intentNote.other}</button>:null}
        </div>
      ) : null}
      <div className="prompt-foot">
        <span className="prompt-target" data-testid="prompt-target">{label}{cost}</span>
        <div className="prompt-foot-right">
          {runners?.length && review !== 'directions' ? (
            <SelectField className="prompt-runner" value={runner} options={[...runners.map((r) => ({ value: r.id, label: r.available ? runnerName(r.id) : r.reason && (r.installed || r.checked) ? t('{runner} (not available)', { runner: runnerName(r.id) }) : t('{runner} (not found)', { runner: runnerName(r.id) }), disabled: !r.available })), ...elsewhere]} onChange={setRunner} testId="prompt-runner" title={t('Which CLI runs this, here or on a paired device that allows it')} />
          ) : null}
          {runner && !deviceId && review !== 'directions' ? <RunChoice runner={runner} scope="prompt" testId="prompt-choice" /> : null}
          {prompt.messages.length && !prompt.running ? <IconButton icon={<MessageSquarePlus size={13} />} title={t('New chat: the agent forgets what was said here')} onClick={newChat} testId="prompt-new-chat" /> : null}
          <SelectField<Review> disabled={Boolean(prompt.redo)} className="prompt-review" value={review} options={[{ value: 'direct', label: t('Change it') }, { value: 'proposal', label: t('Propose') }, { value: 'directions', label: t.n(lanes.length || 3, '{count} direction', '{count} directions') }, { value: 'critique', label: t('Critique') }]} onChange={setReview} testId="prompt-review" title={t('Change the layers, work in copies you accept or discard, race several runs, or only get comments')} />
          <IconButton icon={<X size={13} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={() => editor().set({ prompt: { ...prompt, open: false, redo:undefined } })} />
        </div>
      </div>
    </div>
  );
}
