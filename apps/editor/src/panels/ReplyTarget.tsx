import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Bot, ChevronDown, MessageSquare } from 'lucide-react';
import { CLI_DEFAULT, routeLabel, runnerLabel, setDraft, targetLabel, useDraft, type ReplyTarget as Target, type Route, type Runner } from './conversation-state.ts';
import { useRunSettings } from './RunChoice.tsx';
import { t } from '../i18n/store.ts';
import { useT } from '../i18n/react.ts';

const FOLLOW = '';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Model names as the CLIs give them, for labels. */
export function useModelNames(): Record<string, string> {
  const data = useRunSettings();
  return useMemo(() => {
    const out: Record<string, string> = {};
    for (const catalog of Object.values(data?.catalogs ?? {})) for (const m of catalog.models) out[m.id] = m.label;
    return out;
  }, [data]);
}

/** The chip's words: who gets this message. */
export function routeChip(route: Route, names: Record<string, string>): string {
  if (route.kind === 'comment') return t('Comment only');
  if (route.kind === 'mention') return t('{agents} (mentioned)', { agents: route.runners.map(runnerLabel).join(' + ') });
  return targetLabel(route, names);
}

/**
 * Under a reply: who it goes to, always in sight, and a way to change that for this message. A thread an agent
 * was asked in keeps going to that agent with the same model; Comment only writes without starting anything.
 */
export function ReplyTarget({ route, draftKey, inherited, variant = 'desktop', testId = 'reply-target' }: { route: Route; draftKey: string; inherited: Target | undefined; variant?: 'desktop' | 'phone'; testId?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  // Sent, the draft is gone, and the choice with it: the chooser closes, as the message it was for has left.
  const draft = useDraft(draftKey);
  const had = useRef(Boolean(draft));
  useEffect(() => {
    if (had.current && !draft) setOpen(false);
    had.current = Boolean(draft);
  }, [draft]);
  const names = useModelNames();
  const data = useRunSettings();
  const runner: Runner | null = route.kind === 'agent' ? route.runner : route.kind === 'mention' && route.runners.length === 1 ? route.runners[0]! : null;
  const catalog = runner ? data?.catalogs[runner] : undefined;
  const same = runner !== null && inherited?.runner === runner;
  const followLabel = same ? t('Like this thread ({model})', { model: targetLabel(inherited, names).split(' · ').slice(1).join(' · ') || t('CLI default') }) : t('As set for comments');
  const chosenModel = route.kind === 'comment' ? undefined : route.model;
  const chosenEffort = route.kind === 'comment' ? undefined : route.effort;
  const modelValue = chosenModel !== undefined && !(same && chosenModel === inherited?.model) ? chosenModel : FOLLOW;
  const effortValue = chosenEffort !== undefined && !(same && chosenEffort === inherited?.effort) ? chosenEffort : FOLLOW;
  const models = [
    { value: FOLLOW, label: followLabel },
    { value: CLI_DEFAULT, label: t('CLI default') },
    ...(catalog?.models ?? []).map((m) => ({ value: m.id, label: m.label })),
    ...(modelValue && modelValue !== CLI_DEFAULT && !catalog?.models.some((m) => m.id === modelValue) ? [{ value: modelValue, label: cap(modelValue) }] : []),
  ];
  const effortList = catalog?.models.find((m) => m.id === (chosenModel ?? inherited?.model))?.efforts ?? catalog?.efforts ?? [];
  const efforts = [
    { value: FOLLOW, label: same ? t('Like this thread') : t('As set for comments') },
    { value: CLI_DEFAULT, label: t('CLI default') },
    ...effortList.map((e) => ({ value: e, label: cap(e) })),
    ...(effortValue && effortValue !== CLI_DEFAULT && !effortList.includes(effortValue) ? [{ value: effortValue, label: cap(effortValue) }] : []),
  ];
  const choose = (to: Runner | 'comment') => setDraft(draftKey, { to, model: undefined, effort: undefined });
  const options: { value: Runner | 'comment'; label: string }[] = [{ value: 'claude', label: 'Claude' }, { value: 'codex', label: 'Codex' }, { value: 'comment', label: t('Comment only') }];
  const current = route.kind === 'agent' ? route.runner : route.kind === 'comment' ? 'comment' : null;
  const chosen = route.kind === 'comment' ? route.why === 'chosen' : route.kind === 'agent' ? route.how === 'chosen' : Boolean(route.model && route.model !== inherited?.model);
  return (
    <div className={`reply-target is-${variant}`} data-route={route.kind} data-testid={testId} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <div className="reply-target-row">
        <button type="button" className="reply-target-chip" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((o) => !o)} data-testid={`${testId}-chip`} title={t('Change who this message goes to')}>
          {route.kind === 'comment' ? <MessageSquare size={13} aria-hidden="true" /> : <Bot size={13} aria-hidden="true" />}
          <span className="reply-target-to">{t('To')}</span>
          <span className="reply-target-name" data-testid={`${testId}-name`}>{routeChip(route, names)}</span>
          <ChevronDown size={13} aria-hidden="true" className="reply-target-caret" />
        </button>
        {chosen ? <button type="button" className="reply-target-reset" onClick={() => setDraft(draftKey, { to: undefined, model: undefined, effort: undefined })} data-testid={`${testId}-reset`}>{inherited ? t('Follow thread') : t('Reset')}</button> : null}
      </div>
      <p className="reply-target-note" aria-live="polite" data-testid={`${testId}-note`}>{routeLabel(route, names)}</p>
      {open ? (
        <div className="reply-target-panel" id={`${id}-panel`} role="group" aria-label={t('Who this message goes to')}>
          {route.kind === 'mention' ? <p className="reply-target-note">{t('The mention in your text decides who is asked. Remove it to choose here.')}</p> : (
            <div className="reply-target-options" role="radiogroup" aria-label={t('Recipient')}>
              {options.map((o) => (
                <button key={o.value} type="button" role="radio" aria-checked={current === o.value} className={`reply-target-option${current === o.value ? ' is-on' : ''}`} onClick={() => choose(o.value)} data-testid={`${testId}-${o.value}`}>{o.label}</button>
              ))}
            </div>
          )}
          {runner ? (
            <div className="reply-target-models">
              <label className="reply-target-field">
                <span>{t('Model')}</span>
                <select value={modelValue} onChange={(e) => setDraft(draftKey, { ...(route.kind === 'agent' ? { to: runner } : {}), model: e.target.value || undefined })} onKeyDown={(e) => e.stopPropagation()} data-testid={`${testId}-model`}>
                  {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
              <label className="reply-target-field">
                <span>{t('Effort')}</span>
                <select value={effortValue} onChange={(e) => setDraft(draftKey, { ...(route.kind === 'agent' ? { to: runner } : {}), effort: e.target.value || undefined })} onKeyDown={(e) => e.stopPropagation()} data-testid={`${testId}-effort`}>
                  {efforts.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
