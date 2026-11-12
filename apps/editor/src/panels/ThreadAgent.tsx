import { useEffect, useState } from 'react';
import type { CommentAttachment } from '@bogen/core';
import { Bot, FileText, Square, X } from 'lucide-react';
import { resolveAsset } from '../lib/api.ts';
import { collabApi } from '../lib/collab-api.ts';
import { session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton } from '../ui/controls.tsx';
import { stepLines, toolWords } from './collab-words.ts';
import { useT } from '../i18n/react.ts';

export { stepLines };

/** Files on a message that are not pictures: a PDF, a text, a table. Only files this server holds are linked. */
export function MessageFiles({ files }: { files: CommentAttachment[] }) {
  const t = useT();
  const docs = files.filter((f) => typeof f?.src === 'string' && f.kind !== 'audio' && /^bogen-asset:[a-f0-9]{64}\.(pdf|txt|md|csv|json)$/.test(f.src));
  if (!docs.length) return null;
  return (
    <div className="message-docs">
      {docs.map((f, i) => (
        <a key={i} className="message-doc" href={resolveAsset(f.src)} download={f.name ?? true} onClick={(e) => e.stopPropagation()} data-testid="message-doc" title={t('Agents asked in this thread read it as text')}>
          <FileText size={13} /><span dir="auto">{f.name ?? t('File')}</span>
        </a>
      ))}
    </div>
  );
}

/** Stops a run, or takes a waiting request out of the queue. The thread says what happened either way. */
export async function stopThreadRun(run: { runId?: string; queueId?: string; status: string }): Promise<void> {
  if (run.status === 'working' && run.runId) await collabApi.stopRun(run.runId);
  else if (run.queueId) await collabApi.cancelQueued(run.queueId, session().user.name);
}

/** Under a thread an agent works on: what it waits for or what it did so far, and a way to stop it. */
export function ThreadRunView({ threadId }: { threadId: string }) {
  const t = useT();
  const run = useEditor((s) => s.threadRuns[threadId]);
  const [stopping, setStopping] = useState(false);
  useEffect(() => setStopping(false), [run?.runId, run?.status]);
  if (!run) return null;
  const working = run.status === 'working';
  const lines = working ? stepLines(run.steps ?? []) : [];
  const stop = async () => {
    setStopping(true);
    try {
      await stopThreadRun(run);
    } catch (err) {
      setStopping(false);
      editor().showToast((err as Error).message);
    }
  };
  return (
    <div className="thread-run-box" data-testid="thread-run-box" onClick={(e) => e.stopPropagation()}>
      <div className="thread-run" data-testid="thread-run" data-status={run.status}>
        <Bot size={13} />
        <span className="thread-run-text">
          {stopping ? t('Stopping {runner}', { runner: run.runner }) : run.status === 'queued' ? t('{runner} is waiting for its turn', { runner: run.runner }) : run.tool ? t('{runner} is working: {tool}', { runner: run.runner, tool: toolWords(run.tool).toLowerCase() }) : t('{runner} is working', { runner: run.runner })}
        </span>
        {working && run.runId ? <IconButton icon={<Square size={11} />} title={t('Stop {runner}. What it changed until then stays, and Undo this run takes it back.', { runner: run.runner })} disabled={stopping} onClick={() => void stop()} testId="thread-run-stop" /> : null}
        {!working && run.queueId ? <IconButton icon={<X size={12} />} title={t('Take it out of the queue')} disabled={stopping} onClick={() => void stop()} testId="thread-run-cancel" /> : null}
      </div>
      {!working && run.reason && run.reason !== 'Starting' ? <div className="thread-run-reason" data-testid="thread-run-reason">{run.reason}.</div> : null}
      {lines.length ? (
        <ol className="thread-steps" data-testid="thread-steps" aria-live="polite">
          {lines.map((l, i) => <li key={i} className={i === lines.length - 1 ? 'is-now' : ''}>{l.text}{l.count > 1 ? ` (${l.count})` : ''}</li>)}
        </ol>
      ) : null}
    </div>
  );
}
