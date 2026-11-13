import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api, resolveAsset } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { useT } from '../i18n/react.ts';
import '../styles/browser-capture.css';

interface Reference {
  id: string; title: string; source: 'extension' | 'capture' | 'image'; url?: string; image?: string; fileId?: string; nodeId?: string;
  tags: string[]; note?: string; palette: { hex: string; share: number }[]; type?: { families: { family: string; share: number }[]; sizes: number[] }; addedAt: number;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? String(res.status));
  return data;
}

function host(url?: string): string {
  try { return url ? new URL(url).hostname : ''; } catch { return ''; }
}

/** Settings, References: what the person collected, which agents search before they choose a direction. */
export function ReferencesSection() {
  const t = useT();
  const [items, setItems] = useState<Reference[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const load = useCallback(() => void call<Reference[]>('GET', '/api/references').then((r) => { setItems(r); setError(''); }, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    load();
    return onServerEvent((e) => { if (e.t === 'references') load(); });
  }, [load]);
  const upload = async (list: File[]) => {
    setError('');
    for (const f of list) {
      try {
        const asset = await api.upload(f);
        await call('POST', '/api/references', { image: asset.src, title: f.name.replace(/\.[a-z0-9]+$/i, '') });
      } catch (e) { setError((e as Error).message); }
    }
    load();
  };
  const retag = (r: Reference, tags: string[]) => void call('PATCH', `/api/references/${r.id}`, { tags }).then(load, (e: Error) => setError(e.message));
  const remove = (r: Reference) => void call('DELETE', `/api/references/${r.id}`).then(load, (e: Error) => setError(e.message));
  const q = query.trim().toLocaleLowerCase();
  const shown = (items ?? []).filter((r) => !q || [r.title, host(r.url), r.note ?? '', ...r.tags, ...(r.type?.families.map((f) => f.family) ?? [])].join(' ').toLocaleLowerCase().includes(q));
  const sourceName = (r: Reference) => (r.source === 'extension' ? t('Extension') : r.source === 'capture' ? t('Capture') : t('Picture'));
  return (
    <div className="references" data-testid="setting-references">
      <div className="references-head">
        <p className="settings-hint">{t('Agents search them before they choose a direction. They stay on this computer.')}</p>
        <button type="button" className="btn btn-primary" onClick={() => file.current?.click()} data-testid="references-add">{t('Add image')}</button>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple hidden onChange={(e) => { const list = [...(e.currentTarget.files ?? [])]; e.currentTarget.value = ''; void upload(list); }} data-testid="references-file" />
      </div>
      <label className="references-search"><Search size={14} aria-hidden="true" /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search by tag, site or font')} aria-label={t('Search references')} /></label>
      {error ? <p className="settings-hint" role="alert">{error}</p> : null}
      {items === null ? <p role="status">{t('Reading…')}</p> : !items.length ? <p className="settings-hint" data-testid="references-empty">{t('No references yet. Keep a page with the browser extension, or add an image.')}</p> : null}
      <div className="references-grid">
        {shown.map((r) => (
          <article key={r.id} className="reference-card" data-testid="reference-card">
            <div className="reference-picture">{r.image ? <img src={resolveAsset(r.image)} alt="" loading="lazy" /> : null}</div>
            <div className="reference-text">
              <div className="reference-title-row">
                <strong dir="auto">{r.title}</strong>
                <button type="button" className="reference-remove" title={t('Remove {name}', { name: r.title })} aria-label={t('Remove {name}', { name: r.title })} onClick={() => remove(r)}><X size={14} /></button>
              </div>
              <span className="settings-hint">{[sourceName(r), host(r.url)].filter(Boolean).join(' · ')}</span>
              {r.palette.length ? <div className="reference-palette" aria-label={r.palette.map((c) => c.hex).join(', ')}>{r.palette.map((c) => <span key={c.hex} style={{ background: c.hex }} title={c.hex} />)}</div> : null}
              {r.type?.families.length ? <span className="settings-hint" dir="auto">{r.type.families.map((f) => f.family).join(', ')}{r.type.sizes.length ? ` ${r.type.sizes.length > 1 ? `${r.type.sizes[0]}–${r.type.sizes.at(-1)}` : r.type.sizes[0]} px` : ''}</span> : null}
              <div className="reference-tags">
                {r.tags.map((tag) => <button type="button" key={tag} className="reference-tag" title={t('Remove tag {tag}', { tag })} onClick={() => retag(r, r.tags.filter((x) => x !== tag))}>{tag}</button>)}
                {adding === r.id
                  ? <input className="reference-tag-input" autoFocus aria-label={t('New tag')} onBlur={() => setAdding(null)} onKeyDown={(e) => {
                    if (e.key === 'Escape') setAdding(null);
                    if (e.key === 'Enter' && e.currentTarget.value.trim()) { retag(r, [...r.tags, e.currentTarget.value]); setAdding(null); }
                  }} />
                  : <button type="button" className="reference-tag reference-tag-add" onClick={() => setAdding(r.id)}>{t('+ tag')}</button>}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
