import { useCallback, useEffect, useState } from 'react';
import { agentApi, type MemorySuggestion, type MemoryView } from '../lib/agent-api.ts';
import { onServerEvent } from '../lib/events.ts';
import { session } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { useT } from '../i18n/react.ts';

function Suggestion({ s, onAction }: { s: MemorySuggestion; onAction: (s: MemorySuggestion, action: 'add' | 'dismiss') => void }) {
  const t = useT();
  return (
    <div className="bf-item memory-card" data-testid="memory-suggestion" data-suggestion={s.id}>
      <div>{s.why}</div>
      <div className="memory-rule"><span>{t('Rule')}</span><strong dir="auto">{s.text}</strong></div>
      <div className="bf-row">
        <button type="button" className="btn btn-primary" onClick={() => onAction(s, 'add')} data-testid="memory-add">{t('Add rule')}</button>
        <button type="button" className="btn btn-quiet" onClick={() => onAction(s, 'dismiss')} data-testid="memory-dismiss">{t('Dismiss')}</button>
      </div>
    </div>
  );
}

/** What the person's decisions on proposals say about the brand. Nothing applies until they add it. */
export function MemorySuggestions({ brandId }: { brandId: string }) {
  const t = useT();
  const [view, setView] = useState<MemoryView | null>(null);
  const load = useCallback(() => {
    void agentApi.memory(brandId).then(setView, () => setView(null));
  }, [brandId]);
  useEffect(() => {
    load();
    return onServerEvent((e) => { if ((e.t === 'memory' && e.brandId === brandId) || (e.t === 'brand' && e.id === brandId)) load(); });
  }, [load, brandId]);
  if (!view?.decisions) return null;
  const act = async (s: MemorySuggestion, action: 'add' | 'dismiss') => {
    try {
      await agentApi.memoryAction(brandId, s.id, action, session().user.name);
      if (action === 'add') editor().showToast(t('Added the rule: {rule}. It binds agents from now on.', { rule: s.text }));
      load();
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  return (
    <div data-testid="memory-suggestions">
      <div className="bf-title">{t('From your decisions')}</div>
      <div className="hint">{t('{proposals} decided in {files}: {accepted} accepted, {discarded} discarded.', { proposals: t.n(view.decisions, '{count} proposal', '{count} proposals'), files: t.n(view.files, '{count} file', '{count} files'), accepted: view.accepted, discarded: view.discarded })} {t('Nothing applies until you add it.')}</div>
      {view.suggestions.length ? <div className="bf-list">{view.suggestions.map((s) => <Suggestion key={s.id} s={s} onAction={(x, a) => void act(x, a)} />)}</div> : <div className="hint">{t('No pattern yet. One shows here once the same choice repeats.')}</div>}
      <div className="hint">{t('Agents see a short summary of this in {tool}.', { tool: 'brand_get' })}</div>
    </div>
  );
}
