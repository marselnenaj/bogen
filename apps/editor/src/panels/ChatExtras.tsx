import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Columns3, CopyPlus, Download, GitBranch, GitMerge, MessageSquareText, Minus, PenLine, Plus, X } from 'lucide-react';
import { VARIATION_ASPECTS, VARIATION_RANGES, type VariationAspect, type VariationRange } from '@bogen/core';
import { ASPECT_WORDS, heldLine, RANGE_TITLES, RANGE_WORDS, splitHint, type Mention, type VariationChoice } from './chat-extras-state.ts';
import { session } from '../doc/session.ts';
import { pullApi, type PullDraft } from '../lib/code-api.ts';
import { conversationFor } from '../lib/conversation.ts';
import { onServerEvent } from '../lib/events.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { editor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { IconButton, Segmented, SelectField } from '../ui/controls.tsx';
import { KnowledgeSkill, type PersonalSkill } from './KnowledgeSkill.tsx';
import { RunChoice } from './RunChoice.tsx';
import '../styles/chat-extras.css';

/**
 * What the chat adds this round, next to ChatPanel: the range and aspects of Propose and Directions, the `/` and `@`
 * menu, "Save these decisions as a skill", the trace of a run, and the branch a chat has in a linked repository.
 */

// ---------------------------------------------------------------- the composer's two choices: what the agent does, and who answers

/**
 * A small sheet over the field, opened from a button in the composer. It stays in the page while shut, so what it
 * holds keeps its state; Esc and a click outside close it, and the focus goes back to its button.
 */
function ComposerSheet({ id, open, onClose, anchor, label, testId, className, children }: { id: string; open: boolean; onClose: (refocus: boolean) => void; anchor: React.RefObject<HTMLButtonElement | null>; label: string; testId?: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    el?.querySelector<HTMLElement>('input:checked, select, input, button')?.focus({ preventScroll: true });
    const down = (e: PointerEvent) => {
      const target = e.target as Node;
      if (el?.contains(target) || anchor.current?.contains(target)) return;
      onClose(false);
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  }, [open]);
  return (
    <div
      ref={ref} id={id} role="dialog" aria-label={label} className={`chat-sheet ${className ?? ''}`} hidden={!open} data-testid={testId}
      // Esc closes it from any control inside, even one that keeps its keys to itself (a select).
      onKeyDownCapture={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); } }}
      // The editor's own shortcuts stay out of the sheet.
      onKeyDown={(e) => e.stopPropagation()}
      onBlur={(e) => {
        const next = e.relatedTarget as Node | null;
        if (next && !e.currentTarget.contains(next) && !anchor.current?.contains(next)) onClose(false);
      }}
    >
      {children}
    </div>
  );
}

export type ChatMode = 'direct' | 'proposal' | 'directions' | 'critique';
const MODE_ICONS: Record<ChatMode, typeof PenLine> = { direct: PenLine, proposal: CopyPlus, directions: Columns3, critique: MessageSquareText };

/** The words and the one-line meaning of each mode, as the picker and the first asks show them. */
export function modeWords(mode: ChatMode, lanes: number): { label: string; hint: string } {
  if (mode === 'proposal') return { label: t('Propose'), hint: t('Works in a copy you accept or discard.') };
  if (mode === 'directions') return { label: t.n(lanes || 3, '{count} direction', '{count} directions'), hint: t('Several runs, each in its own copy, side by side.') };
  if (mode === 'critique') return { label: t('Critique'), hint: t('Notes as comments. Nothing changes.') };
  return { label: t('Change it'), hint: t('Edits the layers. Undo takes the whole run back.') };
}

export function ModeIcon({ mode, size = 12 }: { mode: ChatMode; size?: number }) {
  const Icon = MODE_ICONS[mode];
  return <Icon size={size} aria-hidden="true" />;
}

/** What the agent does with the message: each mode with what it means, where it is picked. */
export function ModePicker({ value, onChange, lanes, disabled }: { value: ChatMode; onChange: (mode: ChatMode) => void; lanes: number; disabled?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const current = modeWords(value, lanes);
  return (
    <>
      <button
        ref={button} type="button" className="chat-choice is-mode" disabled={disabled}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={id} aria-label={t('Mode: {mode}', { mode: current.label })}
        title={t('What the agent does with your message')} onClick={() => setOpen((o) => !o)} data-testid="prompt-review" data-value={value}
      >
        <ModeIcon mode={value} />
        <span>{current.label}</span>
        <ChevronDown size={12} aria-hidden="true" className="chat-choice-chevron" />
      </button>
      <ComposerSheet id={id} open={open} onClose={close} anchor={button} label={t('What the agent does with your message')} testId="prompt-review-sheet">
        <fieldset className="chat-sheet-modes" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); close(true); } }}>
          <legend className="chat-sheet-title">{t('What the agent does with your message')}</legend>
          {(['direct', 'proposal', 'directions', 'critique'] as const).map((mode) => {
            const words = modeWords(mode, lanes);
            return (
              <label key={mode} className={`chat-sheet-mode${mode === value ? ' is-on' : ''}`} onPointerUp={() => requestAnimationFrame(() => close(true))}>
                <input type="radio" name={id} value={mode} checked={mode === value} onChange={() => onChange(mode)} data-testid={`prompt-review-${mode}`} />
                <ModeIcon mode={mode} size={14} />
                <span className="chat-sheet-mode-text">
                  <span className="chat-sheet-mode-name">{words.label}</span>
                  <span className="chat-sheet-mode-hint">{words.hint}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      </ComposerSheet>
    </>
  );
}

/**
 * Who answers: the CLI, here or on a paired device, with its model and effort. The button says the model in short;
 * the sheet names each choice.
 */
export function AgentPicker({ runner, options, onRunner, choice, summary, note }: { runner: string; options: { value: string; label: string; disabled?: boolean }[]; onRunner: (id: string) => void; choice: string | null; summary: string; note?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  return (
    <>
      <button
        ref={button} type="button" className="chat-choice is-agent"
        aria-haspopup="dialog" aria-expanded={open} aria-controls={id} aria-label={t('Who answers: {who}', { who: summary })}
        title={t('Who answers, with which model and effort')} onClick={() => setOpen((o) => !o)} data-testid="prompt-agent"
      >
        <span>{summary}</span>
        <ChevronDown size={12} aria-hidden="true" className="chat-choice-chevron" />
      </button>
      <ComposerSheet id={id} open={open} onClose={close} anchor={button} label={t('Who answers')} testId="prompt-agent-sheet" className="is-agent">
        <p className="chat-sheet-title">{t('Who answers')}</p>
        <SelectField className="prompt-runner" label={t('Agent')} value={runner} options={options} onChange={onRunner} testId="prompt-runner" title={t('Which CLI runs this, here or on a paired device that allows it')} />
        {choice ? <RunChoice runner={choice} scope="prompt" testId="prompt-choice" labelled /> : null}
        {note ? <p className="chat-sheet-note">{note}</p> : null}
      </ComposerSheet>
    </>
  );
}

// ---------------------------------------------------------------- variations

export function VariationControls({ mode, value, onChange, sections, runs }: { mode: 'proposal' | 'directions'; value: VariationChoice; onChange: (v: VariationChoice) => void; sections: string[]; runs: number }) {
  const t = useT();
  const set = (patch: Partial<VariationChoice>) => onChange({ ...value, ...patch });
  const toggle = (a: VariationAspect) => set({ vary: value.vary.includes(a) ? value.vary.filter((x) => x !== a) : VARIATION_ASPECTS.filter((x) => x === a || value.vary.includes(x)) });
  const split = mode === 'directions' && value.split ? splitHint(sections, runs) : null;
  return (
    <div className="chat-vary" data-testid="chat-vary">
      {mode === 'proposal' ? (
        <div className="chat-vary-row">
          <span className="chat-vary-label">{t('Copies')}</span>
          <span className="chat-stepper" role="group" aria-label={t('Copies')}>
            <IconButton icon={<Minus size={12} />} title={t('Fewer copies')} disabled={value.count <= 1} onClick={() => set({ count: value.count - 1 })} testId="chat-vary-fewer" />
            <span className="chat-stepper-value" data-testid="chat-vary-count">{value.count}</span>
            <IconButton icon={<Plus size={12} />} title={t('More copies')} disabled={value.count >= 6} onClick={() => set({ count: value.count + 1 })} testId="chat-vary-more" />
          </span>
        </div>
      ) : null}
      <div className="chat-vary-row">
        <span className="chat-vary-label">{t('Range')}</span>
        <Segmented<VariationRange> value={value.range} onChange={(range) => set({ range })} testId="chat-vary-range" options={VARIATION_RANGES.map((r) => ({ value: r, label: t(RANGE_WORDS[r]), title: t(RANGE_TITLES[r]) }))} />
      </div>
      <div className="chat-vary-row">
        <span className="chat-vary-label">{t('Vary')}</span>
        <span className="chat-vary-aspects">
          {VARIATION_ASPECTS.map((a) => (
            <button key={a} type="button" className={`chat-toggle${value.vary.includes(a) ? ' is-on' : ''}`} aria-pressed={value.vary.includes(a)} onClick={() => toggle(a)} data-testid={`chat-vary-${a}`}>{t(ASPECT_WORDS[a])}</button>
          ))}
        </span>
      </div>
      {mode === 'directions' ? (
        <label className="chat-vary-split">
          <input type="checkbox" checked={value.split} onChange={(e) => set({ split: e.target.checked })} data-testid="chat-vary-split" />
          <span>{t('Split the page: each run takes sections')}</span>
        </label>
      ) : null}
      <p className="chat-vary-hint" data-testid="chat-vary-hint">{split ?? heldLine(value.vary)}</p>
    </div>
  );
}

// ---------------------------------------------------------------- the / and @ menu

export interface ChatSkill { id: string; name: string; purpose: string; customized: boolean }
export type PickerItem =
  | { kind: 'skill'; id: string; label: string; detail: string; custom: boolean }
  | { kind: 'save-skill'; id: string; label: string; detail: string }
  | { kind: Mention['kind']; id: string; label: string; detail: string; swatch?: string };

let skillsCache: Promise<ChatSkill[]> | null = null;
export function loadSkills(fresh = false): Promise<ChatSkill[]> {
  if (!skillsCache || fresh) skillsCache = fetch('/api/runs/skills').then((r) => (r.ok ? r.json() : { skills: [] })).then((b: { skills: ChatSkill[] }) => b.skills, () => []);
  return skillsCache;
}

const has = (text: string, q: string) => text.toLowerCase().includes(q.toLowerCase());

/** The entries of the menu for what is typed: playbooks and the person's skills for `/`, things in the file for `@`. */
export function pickerItems(trigger: '/' | '@', query: string, skills: ChatSkill[], artboard: { id: string; name: string } | null): PickerItem[] {
  if (trigger === '/') {
    const matched = skills.filter((s) => !query || has(s.name, query) || has(s.id, query));
    const items: PickerItem[] = [
      ...matched.filter((s) => s.customized).map((s) => ({ kind: 'skill' as const, id: s.id, label: s.name, detail: t('Your version of this playbook'), custom: true })),
      ...matched.filter((s) => !s.customized).map((s) => ({ kind: 'skill' as const, id: s.id, label: s.name, detail: s.purpose, custom: false })),
    ].slice(0, 8);
    if (artboard && (!query || has(t('Save these decisions as a skill'), query) || has('save', query))) items.push({ kind: 'save-skill', id: artboard.id, label: t('Save these decisions as a skill'), detail: t('From {name}: its values and accepted proposals', { name: artboard.name }) });
    return items;
  }
  const s = session();
  const pageId = editor().pageId;
  const nodes = pageId ? s.doc.descendants(pageId) : [];
  const layers = nodes.filter((n) => !n.component && n.name && (!query || has(n.name, query))).slice(0, 5)
    .map((n) => ({ kind: 'layer' as const, id: n.id, label: n.name, detail: n.type === 'text' && n.text ? `"${n.text.slice(0, 40)}"` : n.artboard ? t('Artboard') : `<${n.tag}>` }));
  const seen = new Set<string>();
  const components = s.doc.getPages().flatMap((p) => s.doc.descendants(p.id)).filter((n) => n.component && !seen.has(n.id) && seen.add(n.id) && (!query || has(n.name, query))).slice(0, 4)
    .map((n) => ({ kind: 'component' as const, id: n.id, label: n.name, detail: t('Component') }));
  const tokens = s.doc.getTokens().filter((tk) => !query || has(tk.name, query.replace(/^--/, ''))).slice(0, 5)
    .map((tk) => ({ kind: 'token' as const, id: tk.name, label: `--${tk.name}`, detail: tk.value, ...(tk.kind === 'color' ? { swatch: tk.value } : {}) }));
  return [...layers, ...components, ...tokens];
}

const GROUPS: Record<PickerItem['kind'], string> = { skill: msg('Design playbooks'), 'save-skill': msg('Actions'), layer: msg('Layers'), component: msg('Components'), token: msg('Tokens') };

export function ChatPicker({ items, active, onPick, onHover }: { items: PickerItem[]; active: number; onPick: (item: PickerItem) => void; onHover: (i: number) => void }) {
  const t = useT();
  if (!items.length) return <div className="chat-picker" role="listbox" data-testid="chat-picker"><p className="chat-picker-empty">{t('Nothing matches.')}</p></div>;
  return (
    <div className="chat-picker" role="listbox" aria-label={t('Add to the message')} data-testid="chat-picker">
      {items.map((item, i) => {
        const group = item.kind === 'skill' && item.custom ? msg('Your skills') : GROUPS[item.kind];
        const prev = items[i - 1];
        const prevGroup = prev ? (prev.kind === 'skill' && prev.custom ? msg('Your skills') : GROUPS[prev.kind]) : null;
        return (
          <div key={`${item.kind}:${item.id}`}>
            {group !== prevGroup ? <p className="chat-picker-group">{t(group)}</p> : null}
            <button
              type="button" role="option" aria-selected={i === active} className={`chat-picker-row${i === active ? ' is-active' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); onPick(item); }} onMouseEnter={() => onHover(i)} data-testid="chat-picker-row" data-kind={item.kind}
            >
              <span className="chat-picker-name">
                {'swatch' in item && item.swatch ? <span className="chat-picker-swatch" style={{ background: item.swatch }} aria-hidden="true" /> : null}
                <span dir="auto">{item.label}</span>
                {item.kind === 'skill' && item.custom ? <span className="chat-picker-tag">{t('Custom')}</span> : null}
              </span>
              <span className="chat-picker-detail" dir="auto">{item.detail}</span>
            </button>
          </div>
        );
      })}
      <p className="chat-picker-foot">{t('Enter to add, Esc to close')}</p>
    </div>
  );
}

// ---------------------------------------------------------------- save these decisions as a skill

interface Draft { discipline: string; revision: string; section: string; markdown: string; decisions: number }

export function SkillSheet({ fileId, nodeId, name, initial, onClose }: { fileId: string; nodeId: string; name: string; initial?: string; onClose: () => void }) {
  const t = useT();
  const [skills, setSkills] = useState<ChatSkill[]>([]);
  // The skill chosen with / in this chat, else the one Bogen would pick for the artboard.
  const [discipline, setDiscipline] = useState<string | undefined>(initial);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonalSkill | null>(null);
  useEffect(() => { void loadSkills().then(setSkills); }, []);
  useEffect(() => {
    let live = true;
    setDraft(null);
    setError(null);
    void fetch('/api/runs/skill-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId, nodeId, ...(discipline ? { discipline } : {}) }) })
      .then(async (r) => { const body = await r.json(); if (!r.ok) throw new Error(body.error ?? String(r.status)); return body as Draft; })
      .then((d) => { if (live) { setDraft(d); setDiscipline(d.discipline); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [fileId, nodeId, discipline]);
  const review = async () => {
    if (!draft) return;
    // The skill editor opens on the draft: nothing is saved until the person saves it there.
    try {
      sessionStorage.setItem(`bogen-skill-draft:${draft.discipline}`, JSON.stringify({ markdown: draft.markdown, revision: draft.revision }));
    } catch {
      // The editor then opens on the saved skill, and the section is still in the preview to copy.
    }
    const res = await fetch(`/api/design-knowledge?${new URLSearchParams({ action: 'skill', discipline: draft.discipline })}`);
    if (!res.ok) return setError(t('Could not open the skill.'));
    setEditing(await res.json() as PersonalSkill);
  };
  return createPortal(
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog chat-skill-sheet" role="dialog" aria-modal="true" aria-label={t('Save these decisions as a skill')} data-testid="chat-skill-sheet" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } }}>
        {editing ? <KnowledgeSkill initial={editing} startEditing onClose={onClose} /> : (
          <>
            <header className="dialog-head">
              <span className="chat-skill-title">{t('Save these decisions as a skill')}</span>
              <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={onClose} testId="chat-skill-close" />
            </header>
            <div className="chat-skill-body">
              <div className="chat-skill-pick">
                <span>{t('Skill')}</span>
                <SelectField value={discipline ?? ''} options={skills.map((s) => ({ value: s.id, label: s.name }))} onChange={setDiscipline} title={t('Skill')} testId="chat-skill-discipline" />
              </div>
              <p className="hint">{t.n(draft?.decisions ?? 0, 'From {name}: what it settled on and {count} accepted proposal.', 'From {name}: what it settled on and {count} accepted proposals.', { name })}</p>
              {error ? <div className="error" data-testid="chat-skill-error">{error}</div> : <pre className="code chat-skill-preview" data-testid="chat-skill-preview">{draft?.section ?? t('Loading')}</pre>}
              <p className="hint">{t('Nothing is saved until you save the skill.')}</p>
            </div>
            <footer className="pr-foot">
              <button type="button" className="btn btn-quiet" onClick={onClose}>{t('Cancel')}</button>
              <button type="button" className="btn btn-primary" disabled={!draft} onClick={() => void review()} data-testid="chat-skill-review">{t('Review and edit')}</button>
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- a run's trace

export function TraceLink({ runId }: { runId: string }) {
  const t = useT();
  const title = t('Download the trace: prompt, tool calls, timings and touched layers as JSON. Secrets and outside files are left out.');
  return (
    <a className="icon-btn" href={`/api/runs/trace/${encodeURIComponent(runId)}?download=1`} download title={title} aria-label={title} data-testid="chat-trace">
      <Download size={13} />
    </a>
  );
}

// ---------------------------------------------------------------- the chat's branch in a repository

/** The branch this chat has in the linked repository, with what it waits for; and the chat closed once it was merged. */
export function ChatBranch({ fileId, closed, onNewChat }: { fileId: string; closed?: { branch?: string; into?: string } | undefined; onNewChat: () => void }) {
  const t = useT();
  const [draft, setDraft] = useState<PullDraft | null>(null);
  const conversation = conversationFor(fileId);
  useEffect(() => {
    let live = true;
    const load = () => void pullApi.list(fileId).then((a) => {
      if (live) setDraft(a.drafts.find((d) => (d as PullDraft & { conversationId?: string }).conversationId === conversation) ?? null);
    }, () => {});
    load();
    const off = onServerEvent((e) => { if (e.t === 'pull' && e.fileId === fileId) load(); });
    return () => { live = false; off(); };
  }, [fileId, conversation]);
  if (closed) {
    return (
      <div className="chat-branch is-closed" data-testid="chat-branch" data-status="merged">
        <p><GitMerge size={13} aria-hidden="true" /> <span>{t.rich('Merged into {base}. This chat is closed.', { base: <span className="pr-mono">{closed.into ?? 'main'}</span> })}</span></p>
        <button type="button" className="chat-pill" onClick={onNewChat} data-testid="chat-branch-new"><Plus size={12} /> {t('New chat')}</button>
      </div>
    );
  }
  if (!draft || draft.status === 'merged') return null;
  const extra = draft as PullDraft & { commits?: number };
  const state = draft.status === 'running' ? t('Your agent is working on it.') : draft.status === 'ready' ? t('Ready to push.') : draft.status === 'opened' ? t('Pushed. Waiting for the merge.') : draft.status === 'failed' ? t('The last change did not work.') : '';
  return (
    <div className="chat-branch" data-testid="chat-branch" data-status={draft.status}>
      <p>
        <GitBranch size={13} aria-hidden="true" />
        <span>{t.rich('{branch} in {project}, a working folder for this chat.', { branch: <span className="pr-mono">{draft.branch}</span>, project: draft.project.name })} {t.n(extra.commits ?? (draft.commit ? 1 : 0), '{count} commit.', '{count} commits.')} {state}</span>
      </p>
      <span className="chat-branch-actions">
        <button type="button" className="chat-pill" onClick={() => ui().set({ pull: { draft: draft.id } })} data-testid="chat-branch-open">{draft.status === 'ready' ? t('Review and push') : t('Open')}</button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- client comments to one run

export function ClientRunBar({ picked, onSent }: { picked: string[]; onSent: (ids: string[]) => void }) {
  const t = useT();
  const [runners, setRunners] = useState<string[]>([]);
  const [runner, setRunner] = useState('claude');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch('/api/runners').then((r) => r.json()).then((list: { id: string; available: boolean }[]) => {
      const ok = list.filter((r) => r.available && (r.id === 'claude' || r.id === 'codex')).map((r) => r.id);
      setRunners(ok);
      if (ok.length && !ok.includes(runner)) setRunner(ok[0]!);
    }, () => {});
  }, []);
  if (!picked.length) return null;
  const send = async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/shares/inbox/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: picked, runner }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      onSent(picked);
      editor().showToast(t.n(picked.length, 'Sent {count} comment to one run. The thread gets the answer.', 'Sent {count} comments to one run. Each thread gets the answer.'));
    } catch (e) {
      editor().showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="publish-line client-run-bar" data-testid="client-run-bar">
      <b>{t.n(picked.length, '{count} selected', '{count} selected')}</b>
      <span className="hint">{t('One run in a proposal. Each thread gets an answer when it ends.')}</span>
      <span className="publish-grow" />
      <SelectField value={runner} options={runners.map((r) => ({ value: r, label: r }))} onChange={setRunner} title={t('Which CLI runs this')} testId="client-run-runner" />
      <button type="button" className="btn btn-primary" disabled={busy || !runners.length} onClick={() => void send()} data-testid="client-run-send">{t('Send to one run')}</button>
    </div>
  );
}
