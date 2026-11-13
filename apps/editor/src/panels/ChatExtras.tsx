import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, GitBranch, GitMerge, Minus, Plus, X } from 'lucide-react';
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
import '../styles/chat-extras.css';

/**
 * What the chat adds this round, next to ChatPanel: the range and aspects of Propose and Directions, the `/` and `@`
 * menu, "Save these decisions as a skill", the trace of a run, and the branch a chat has in a linked repository.
 */

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
