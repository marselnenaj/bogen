import { useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { ArrowRight, Undo2 } from 'lucide-react';
import { agentApi, type RunRecord } from '../lib/agent-api.ts';
import { collabApi, type RunSummary } from '../lib/collab-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { loadUser } from '../lib/user.ts';
import { jumpToLayers } from '../ops/jump.ts';
import { editor } from '../state/store.ts';
import { layerChips, undoWords } from './collab-words.ts';
import { useT } from '../i18n/react.ts';

/**
 * Under an agent's last words: the layers it changed, as links that select them, a small picture of before and
 * after when something visible changed, and Undo this run, which takes it all back as one step.
 */
export function RunResult({ fileId, runId, variant = 'editor', onLayer }: { fileId: string; runId: string; variant?: 'editor' | 'phone'; onLayer?: (id: string) => void }) {
  const t = useT();
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => void collabApi.summary(fileId, runId).then(setSummary, () => setSummary(null)), [fileId, runId]);
  useEffect(() => {
    load();
    return onServerEvent((e) => {
      if (e.t === 'run-history' && e.fileId === fileId) load();
    });
  }, [load, fileId]);
  if (!summary || !summary.layers.length) return null;
  const { shown, more } = layerChips(summary.layers);
  const select = (id: string) => {
    if (onLayer) return onLayer(id);
    if (!jumpToLayers([id], summary.pageId)) editor().showToast(t('That layer is gone.'));
  };
  const undo = async () => {
    setBusy(true);
    try {
      setNote(undoWords(await collabApi.undoRun(fileId, runId, loadUser().name)));
      load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`run-result is-${variant}`} data-testid="run-changes" data-run-id={runId}>
      <div className="run-result-layers">
        <span className="run-result-label">{t('Changed')}</span>
        {shown.map((l) => (
          l.gone
            ? <span key={l.id} className="run-result-layer is-gone" title={t('Removed by this run')} dir="auto">{l.name}</span>
            : <button key={l.id} type="button" className="run-result-layer" onClick={() => select(l.id)} title={t('Select it')} dir="auto" data-testid="run-changes-layer">{l.name}</button>
        ))}
        {more ? <span className="run-result-more">{t.n(more, 'and {count} more', 'and {count} more')}</span> : null}
      </div>
      {summary.shots ? (
        <div className="run-result-shots" data-testid="run-changes-shots">
          {summary.shots.before ? <img src={collabApi.shot(fileId, runId, 'before')} alt={t('Before this run')} /> : <span className="run-result-none">{t('New')}</span>}
          <ArrowRight size={12} aria-hidden="true" />
          {summary.shots.after ? <img src={collabApi.shot(fileId, runId, 'after')} alt={t('After this run')} /> : <span className="run-result-none">{t('Removed')}</span>}
        </div>
      ) : null}
      <div className="run-result-foot">
        {summary.undone
          ? <span className="run-result-note" data-testid="run-changes-undone">{note ?? t('Taken back by {name}.', { name: summary.undone.by })}</span>
          : <button type="button" className="run-result-undo" disabled={busy || summary.status === 'running'} onClick={() => void undo()} data-testid="run-undo" title={t('Takes back everything this run changed, as one step. What someone changed since stays.')}><Undo2 size={12} /> {t('Undo this run')}</button>}
        {!summary.undone && note ? <span className="run-result-note">{note}</span> : null}
      </div>
    </div>
  );
}

interface Records { fileId: string | null; list: RunRecord[]; load: (fileId: string) => void }

/** The run history of the open file, once for all threads. */
const useRecords = create<Records>((set, get) => ({
  fileId: null,
  list: [],
  load: (fileId) => {
    if (get().fileId !== fileId) set({ fileId, list: [] });
    void agentApi.runs(fileId).then((list) => { if (get().fileId === fileId) set({ list }); }, () => {});
  },
}));
let listening = false;

/** The last run that answered a thread, with what it changed, once it is over. */
export function ThreadResult({ fileId, threadId, variant = 'editor' }: { fileId: string; threadId: string; variant?: 'editor' | 'phone' }) {
  const list = useRecords((s) => (s.fileId === fileId ? s.list : null));
  useEffect(() => {
    if (useRecords.getState().fileId !== fileId) useRecords.getState().load(fileId);
    if (listening) return;
    listening = true;
    onServerEvent((e) => {
      const { fileId: open, load } = useRecords.getState();
      if (e.t === 'run-history' && e.fileId === open) load(open);
    });
  }, [fileId]);
  const last = list?.find((r) => r.threadId === threadId);
  if (!last || last.status === 'running' || !last.layers.length) return null;
  return <RunResult fileId={fileId} runId={last.id} variant={variant} />;
}
