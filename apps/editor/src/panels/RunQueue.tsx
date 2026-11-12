import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Square, X } from 'lucide-react';
import { collabApi, type QueueRow, type RunQueueView } from '../lib/collab-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton } from '../ui/controls.tsx';
import { movable, toolWords } from './collab-words.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';
import { msg } from '../i18n/core.ts';

const SOURCE: Record<string, string> = { prompt: msg('from the prompt'), comment: msg('from a comment'), race: msg('in a race'), live: msg('on a live site'), remote: msg('asked from another device'), elsewhere: msg('asked from here') };

function since(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return s < 60 ? t.n(s, '{count} s', '{count} s') : t.n(Math.floor(s / 60), '{count} min', '{count} min');
}

/** Where a row is: this file, or another one by name. */
function where(row: QueueRow, fileId: string | null): string {
  return row.fileId === fileId ? t('this file') : row.fileName;
}

/**
 * What runs and what waits on this computer, over all files: runs going, then comments waiting in the order they
 * would start, each with what it waits for. Waiting comments move up and down and come out of the queue; a race's
 * lanes wait in their race, and come out of it.
 */
/** Where a running row was asked from, in one phrase. */
function source(row: QueueRow): string {
  if (row.source === 'remote' && row.device) return t('asked from {device}', { device: row.device });
  if (row.source === 'elsewhere' && row.device) return t('asked from here, runs on {device}', { device: row.device });
  const words = SOURCE[row.source ?? ''];
  return words ? t(words) : '';
}

export function RunQueue() {
  useT();
  const fileId = useEditor((s) => s.fileId);
  const [view, setView] = useState<RunQueueView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef(0);
  const load = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void collabApi.queue().then((v) => { setView(v); setError(null); }, (e: Error) => setError(e.message)), 120);
  }, []);
  useEffect(() => {
    load();
    const off = onServerEvent((e) => {
      if (e.t === 'comment-run' || e.t === 'run-queue' || e.t === 'race' || e.t === 'run-history' || (e.t === 'agent' && e.kind !== 'text')) load();
    });
    // The time each has been going for, and a run on another device, which sends no events here.
    const tick = window.setInterval(load, 5000);
    return () => {
      off();
      clearInterval(tick);
      clearTimeout(timer.current);
    };
  }, [load]);

  const act = async (fn: () => Promise<RunQueueView | unknown>) => {
    try {
      const next = await fn();
      if (next && typeof next === 'object' && 'running' in next) setView(next as RunQueueView);
      else load();
    } catch (err) {
      editor().showToast((err as Error).message);
      load();
    }
  };

  if (!view) return error ? <div className="section-plain"><div className="feed-title">{t('Queue')}</div><div className="hint">{error}</div></div> : null;
  const order = movable(view.queued);
  const open = (row: QueueRow) => {
    if (row.fileId !== fileId) location.hash = `#/file/${row.fileId}`;
    else if (row.threadId) editor().set({ rightTab: 'comments', activeThreadId: row.threadId });
  };
  return (
    <div className="section-plain run-queue" data-testid="run-queue">
      <div className="feed-title">{t('Queue')} <span className="queue-count">{view.queued.length ? t('{running} of {limit} going, {waiting} waiting', { running: view.running.length, limit: view.limit, waiting: view.queued.length }) : t('{running} of {limit} going', { running: view.running.length, limit: view.limit })}</span></div>
      {!view.running.length && !view.queued.length ? <div className="hint">{t('Nothing runs or waits. Runs from the prompt start at once; comments wait here when their file or this computer is busy.')}</div> : null}
      {view.running.map((row) => (
        <div key={row.runId ?? row.id} className="queue-row is-running" data-testid="queue-running">
          <span className="run-dot" />
          <button type="button" className="queue-main" onClick={() => open(row)} title={row.title}>
            <span className="queue-title" dir="auto">{row.title || t('A run')}</span>
            <span className="queue-meta">{row.agent ?? row.runner} · {where(row, fileId)} · {source(row)} · {since(row.at)}{row.tool ? ` · ${toolWords(row.tool).toLowerCase()}` : ''}</span>
          </button>
          {row.runId ? <IconButton icon={<Square size={11} />} title={t('Stop this run')} onClick={() => void act(() => collabApi.stopRun(row.runId!))} testId="queue-stop" /> : null}
        </div>
      ))}
      {view.queued.map((row) => {
        const at = order.indexOf(row.id);
        return (
          <div key={row.id} className="queue-row" data-testid="queue-waiting" data-queue-id={row.id}>
            <span className="queue-pos">{at >= 0 ? at + 1 : ''}</span>
            <button type="button" className="queue-main" onClick={() => open(row)} title={row.title}>
              <span className="queue-title" dir="auto">{row.title || t('A comment')}</span>
              <span className="queue-meta">{row.agent ?? row.runner} · {where(row, fileId)}{row.kind === 'race' ? ` · ${t('a lane of a race')}` : ''}</span>
              <span className="queue-reason" data-testid="queue-reason">{row.reason}</span>
            </button>
            {row.kind === 'comment' ? (
              <>
                <IconButton icon={<ArrowUp size={12} />} title={t('Start it sooner')} disabled={at <= 0} onClick={() => void act(() => collabApi.moveQueued(row.id, at - 1))} testId="queue-up" />
                <IconButton icon={<ArrowDown size={12} />} title={t('Start it later')} disabled={at < 0 || at >= order.length - 1} onClick={() => void act(() => collabApi.moveQueued(row.id, at + 1))} testId="queue-down" />
              </>
            ) : null}
            <IconButton icon={<X size={12} />} title={row.kind === 'race' ? t('Take this lane out of its race') : t('Take it out of the queue. The thread says so.')} onClick={() => void act(() => collabApi.cancelQueued(row.id, session().user.name))} testId="queue-cancel" />
          </div>
        );
      })}
    </div>
  );
}
