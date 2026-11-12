import { useCallback, useEffect, useState } from 'react';
import { RotateCw, Square } from 'lucide-react';
import { agentApi, type RunRecord } from '../lib/agent-api.ts';
import { api } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { jumpToLayers } from '../ops/jump.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton } from '../ui/controls.tsx';
import { RunResult } from './RunResult.tsx';
import { msg } from '../i18n/core.ts';
import { formatDate } from '../i18n/format.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

const STATUS: Record<RunRecord['status'], string> = { running: msg('Running'), done: msg('Done'), failed: msg('Failed'), stopped: msg('Stopped'), interrupted: msg('Cut off') };

export function duration(ms: number | undefined): string {
  if (ms === undefined) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? t('{seconds} s', { seconds: s }) : t('{minutes} min {seconds} s', { minutes: Math.floor(s / 60), seconds: s % 60 });
}

function when(at: number): string {
  const s = Math.floor((Date.now() - at) / 1000);
  if (s < 60) return t('just now');
  if (s < 3600) return t.n(Math.floor(s / 60), '{count} min ago', '{count} min ago');
  if (s < 86400) return t.n(Math.floor(s / 3600), '{count} h ago', '{count} h ago');
  return formatDate(at, { year: 'numeric', month: 'numeric', day: 'numeric' });
}

function modelOf(run: RunRecord): string {
  return [run.actualModel ?? run.model ?? t('default model'), run.effort].filter(Boolean).join(', ');
}

function RunRow({ run, fileId }: { run: RunRecord; fileId: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const rerun = async () => {
    try {
      await agentApi.rerun(fileId, run.id);
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  const uses = run.tools.reduce((n, tool) => n + tool.count, 0);
  return (
    <div className={`run-row is-${run.status}`} data-testid="run-row" data-status={run.status}>
      <button type="button" className="run-head" onClick={() => setOpen(!open)} data-testid="run-toggle">
        <span className="run-dot" />
        <span className="run-prompt" dir="auto">{(run.title || run.prompt).replace(/\s+/g, ' ').slice(0, 120)}</span>
        <span className="run-when">{when(run.startedAt)}</span>
      </button>
      {open ? (
        <div className="run-detail" data-testid="run-detail">
          <div className="run-meta">{run.runner} · {modelOf(run)} · {t(STATUS[run.status])}{run.durationMs !== undefined ? ` · ${duration(run.durationMs)}` : ''}{run.source === 'comment' ? ` · ${t('from a comment')}` : ''}</div>
          {run.knowledge ? <div className="run-meta" data-testid="run-knowledge" title={run.knowledge.revision}>{t('Design knowledge')}: {run.knowledge.discipline} · {t(run.knowledge.customized?'Custom':'Original')}</div> : null}
          {(run.title || run.prompt).length > 120 ? <div className="run-text" dir="auto">{run.title || run.prompt}</div> : null}
          {run.nudged ? <div className="run-meta" data-testid="run-nudged" title={run.firstReply ? t('It first said: {reply}', { reply: run.firstReply }) : undefined}>{t('It replied without changing anything, so Bogen asked it once more to make the change.')}</div> : null}
          {run.error ? <div className="run-text run-error">{run.error}</div> : null}
          {run.result ? <div className="run-text" dir="auto" data-testid="run-result">{run.result}</div> : null}
          {uses ? <div className="run-meta" data-testid="run-tools">{run.tools.map((tool) => `${tool.name}${tool.count > 1 ? ` ${tool.count}x` : ''}`).join(', ')}</div> : null}
          {run.layers.length ? (
            <button type="button" className="run-link" data-testid="run-layers" onClick={() => { if (!jumpToLayers(run.layers, run.pageId)) editor().showToast(t('Those layers are gone.')); }}>{t.n(run.layers.length, '{count} layer touched', '{count} layers touched')}</button>
          ) : null}
          {run.files?.length ? <div className="run-meta" data-testid="run-files">{run.files.join(', ')}</div> : null}
          {run.status !== 'running' && run.layers.length && run.source !== 'live' ? <RunResult fileId={fileId} runId={run.id} /> : null}
          <div className="run-actions">
            {run.status === 'running'
              ? <IconButton icon={<Square size={12} />} title={t('Stop this run')} onClick={() => void api.stopRun(run.id)} testId="run-stop" />
              : <IconButton icon={<RotateCw size={13} />} title={t('Run this again')} onClick={() => void rerun()} testId="run-again" />}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** What ran in this file, also before the last restart. */
export function RunHistory() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const load = useCallback(() => {
    if (fileId) void agentApi.runs(fileId).then(setRuns, () => setRuns([]));
  }, [fileId]);
  useEffect(() => {
    load();
    return onServerEvent((e) => {
      if ((e.t === 'run-history' && e.fileId === fileId) || (e.t === 'agent' && e.fileId === fileId && e.kind === 'tool')) load();
    });
  }, [load, fileId]);
  return (
    <div className="section-plain" data-testid="run-history">
      <div className="feed-title">{t('Runs')}</div>
      {!runs.length ? <div className="hint">{t('Nothing has run in this file yet. {shortcut} asks your agent, or mention @claude or @codex in a comment.', { shortcut: 'Ctrl+K' })}</div> : null}
      {runs.slice(0, 40).map((run) => <RunRow key={run.id} run={run} fileId={fileId!} />)}
    </div>
  );
}
