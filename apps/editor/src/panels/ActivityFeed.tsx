import { useCallback, useEffect, useState } from 'react';
import { ChevronRight, RotateCcw } from 'lucide-react';
import { agentApi, type AgentStep, type LayerChange } from '../lib/agent-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { jumpToLayers } from '../ops/jump.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton } from '../ui/controls.tsx';
import { formatDate } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

function timeAgo(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t('{minutes}m ago', { minutes: Math.floor(s / 60) });
  if (s < 86400) return t('{hours}h ago', { hours: Math.floor(s / 3600) });
  return formatDate(at, {});
}

function shown(value: unknown): string {
  if (value === undefined) return t('not set');
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function Change({ change }: { change: LayerChange }) {
  const t = useT();
  const name = change.name || change.nodeId;
  if (change.kind !== 'changed') return <div className="step-line" dir="auto">{change.kind === 'added' ? t('Added {name}', { name }) : t('Removed {name}', { name })}</div>;
  return (
    <div className="step-change">
      <div className="step-line" dir="auto">{name}</div>
      {change.fields.map((f) => (
        <div key={f.field} className="step-field" data-testid="step-field">
          <span className="step-key">{f.field.replace(/^style\./, '')}</span>
          <span className="step-before">{shown(f.before)}</span>
          <span className="step-arrow">{t('to')}</span>
          <span className="step-after">{shown(f.after)}</span>
        </div>
      ))}
    </div>
  );
}

function Preview({ fileId, step, which }: { fileId: string; step: AgentStep; which: 'before' | 'after' }) {
  const t = useT();
  const [missing, setMissing] = useState(false);
  return (
    <figure className="step-shot">
      <figcaption>{which === 'before' ? t('Before') : t('After')}</figcaption>
      {missing
        ? <div className="step-none">{which === 'before' ? t('Not there yet') : t('Nothing left')}</div>
        : <img src={agentApi.stepPreview(fileId, step.id, which)} alt={which === 'before' ? t('The layer before this step') : t('The layer after this step')} onError={() => setMissing(true)} data-testid={`step-${which}`} />}
    </figure>
  );
}

function StepRow({ step, fileId, onChanged }: { step: AgentStep; fileId: string; onChanged: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ids = step.changes.filter((c) => c.kind !== 'removed').map((c) => c.nodeId);
  const undo = async () => {
    try {
      const { undone } = await agentApi.undoStep(fileId, step.id);
      if (!undone) editor().showToast(t('Nothing left of that step to undo.'));
      onChanged();
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  const n = step.changes.length;
  const tool = step.tool;
  const summary = n
    ? (step.undone ? t.n(n, '{tool}, {count} layer, undone', '{tool}, {count} layers, undone', { tool }) : t.n(n, '{tool}, {count} layer', '{tool}, {count} layers', { tool }))
    : (step.undone ? t('{tool}, undone', { tool }) : tool);
  return (
    <div className={`step${step.undone ? ' is-undone' : ''}`} data-testid="feed-step" data-undone={step.undone ? 'true' : 'false'}>
      <div className="step-head">
        <IconButton className={`step-open${open ? ' is-open' : ''}`} icon={<ChevronRight size={12} />} title={open ? t('Hide the change') : t('Show the change')} onClick={() => setOpen(!open)} testId="feed-expand" />
        <button
          type="button"
          className="feed-row"
          data-testid="feed-row"
          title={ids.length ? t('Go to these layers') : undefined}
          onClick={() => { if (ids.length && !jumpToLayers(ids, step.pageId)) editor().showToast(t('Those layers are gone.')); }}
        >
          <span className="feed-agent">{step.agent}</span>
          <span className="feed-tool">{summary}</span>
          <span className="feed-time">{timeAgo(step.at)}</span>
        </button>
        <IconButton icon={<RotateCcw size={12} />} title={t('Undo this step of {agent}', { agent: step.agent })} disabled={step.undone} onClick={() => void undo()} testId="feed-undo" />
      </div>
      {open ? (
        <div className="step-detail" data-testid="feed-detail">
          {step.changes.length ? <div className="step-shots"><Preview fileId={fileId} step={step} which="before" /><Preview fileId={fileId} step={step} which="after" /></div> : null}
          {step.changes.slice(0, 12).map((c) => <Change key={c.nodeId} change={c} />)}
          {step.changes.length > 12 ? <div className="hint">{t.n(step.changes.length - 12, 'And {count} more layer.', 'And {count} more layers.')}</div> : null}
          {!step.changes.length ? <div className="hint">{t('No layers changed: a comment or a token.')}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

/** What agents did in this file, step by step. Lasts while the file is loaded on the server, as undo does. */
export function ActivityFeed() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const load = useCallback(() => {
    if (fileId) void agentApi.steps(fileId).then(setSteps, () => {});
  }, [fileId]);
  useEffect(() => {
    load();
    return onServerEvent((e) => {
      if (e.t === 'activity' && e.fileId === fileId) load();
    });
  }, [load, fileId]);
  return (
    <div className="feed" data-testid="feed">
      <div className="feed-title">{t('Activity')}</div>
      {!steps.length ? <div className="hint">{t('Nothing yet. What agents do in this file appears here as it happens.')}</div> : null}
      {steps.slice(0, 80).map((s) => <StepRow key={s.id} step={s} fileId={fileId!} onChanged={load} />)}
    </div>
  );
}
