import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { brandApi } from '../lib/brand-api.ts';
import { IconButton } from '../ui/controls.tsx';
import { DesignKnowledge } from '../panels/DesignKnowledge.tsx';
import { useT } from '../i18n/react.ts';

interface Template { id: string; name: string; description: string; discipline: string; example?: boolean; parts: { key: string; name: string; size: string }[] }
export function BrandTemplates({ brandId, onClose }: { brandId: string; onClose: () => void }) {
  const t = useT(), ref = useRef<HTMLDivElement>(null), back = useRef(document.activeElement), close = useRef(onClose);
  close.current = onClose;
  const [templates, setTemplates] = useState<Template[]>([]), [selected, setSelected] = useState('app-flow'), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const working = useRef(busy); working.current = busy;
  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/brands/templates', { signal: abort.signal }).then(async (r) => { if (!r.ok) throw new Error(String(r.status)); const list = await r.json() as Template[]; setTemplates(list.filter((t) => !t.example)); }).catch((e: Error) => { if (!abort.signal.aborted) setError(e.message); });
    ref.current?.querySelector<HTMLSelectElement>('select')?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !working.current) { e.preventDefault(); e.stopPropagation(); close.current(); } };
    window.addEventListener('keydown', key, true);
    return () => { abort.abort(); window.removeEventListener('keydown', key, true); if (back.current instanceof HTMLElement && back.current.isConnected) back.current.focus(); };
  }, []);
  const active = templates.find((t) => t.id === selected);
  const create = async () => {
    if (!active || busy) return;
    setBusy(true); setError('');
    try { const out = await brandApi.useTemplate(brandId, active.id); close.current(); location.hash = `#/file/${out.file_id}`; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };
  return <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.currentTarget === e.target && !busy) close.current(); }}>
    <div ref={ref} className="dialog settings" role="dialog" aria-modal="true" aria-label={t('Templates')} data-testid="brand-templates">
      <header className="dialog-head settings-head"><span>{t('Templates')}</span><IconButton icon={<X size={14} />} title={t('Close')} onClick={() => { if (!busy) close.current(); }} testId="templates-close" /></header>
      <div className="settings-body">
        <select className="knowledge-template-choice" value={selected} aria-label={t('Template')} onChange={(e) => setSelected(e.target.value)} disabled={busy} data-testid="template-choice" lang="en">{templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        {active ? <div lang="en"><p>{active.description}</p><ul>{active.parts.map((p) => <li key={p.key}>{p.name} · {p.size}</li>)}</ul></div> : null}
        <DesignKnowledge initialDiscipline={active?.discipline} />
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <footer className="settings-foot"><button type="button" className="btn btn-primary" onClick={() => void create()} disabled={!active || busy} data-testid="template-create">{busy ? t('Laying out a new file…') : t('New file')}</button></footer>
    </div>
  </div>;
}
