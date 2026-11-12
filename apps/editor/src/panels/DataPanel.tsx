import { useState } from 'react';
import { deleteDataSource, repeatsOfSource, type DataSource } from '@bogen/core';
import { Plus, Trash2 } from 'lucide-react';
import { session } from '../doc/session.ts';
import { addSource, ago, refreshSource, sourceOrigin, useDataSources } from '../ops/data.ts';
import { editor } from '../state/store.ts';
import { Empty, IconButton, Segmented } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';

type AddKind = 'paste' | 'upload' | 'url';

function SourceRow({ source }: { source: DataSource }) {
  const t = useT();
  const s = session();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = repeatsOfSource(s.doc, source.id);
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await refreshSource(source.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="data-source" data-testid="data-source" data-source={source.name}>
      <div className="data-source-head">
        <span className="data-source-name" dir="auto">{source.name}</span>
        <button type="button" className="data-link" disabled={busy} onClick={() => void refresh()} data-testid="data-refresh">{busy ? t('Reading') : t('Refresh')}</button>
        <IconButton className="row-action" icon={<Trash2 size={13} />} title={t('Remove {name}', { name: source.name })} onClick={() => s.tx(() => deleteDataSource(s.doc, source.id))} tabIndex={-1} />
      </div>
      <div className="hint">{source.allowLocal
        ? t.n(source.records.length, '{count} record, {origin}, {ago}, this computer\'s network', '{count} records, {origin}, {ago}, this computer\'s network', { origin: sourceOrigin(source), ago: ago(source.updatedAt) })
        : t.n(source.records.length, '{count} record, {origin}, {ago}', '{count} records, {origin}, {ago}', { origin: sourceOrigin(source), ago: ago(source.updatedAt) })}</div>
      <div className="data-fields">{source.fields.slice(0, 12).join(' ')}</div>
      {templates.length ? <button type="button" className="data-link is-start" onClick={() => editor().set({ selection: templates })}>{t.n(templates.length, '{count} template', '{count} templates')}</button> : null}
      {error ? <div className="error" data-testid="data-error">{error}</div> : null}
    </div>
  );
}

function AddSource() {
  const t = useT();
  const [kind, setKind] = useState<AddKind>('paste');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [path, setPath] = useState('');
  const [local, setLocal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const add = async (body?: string, fileName?: string) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const fallback = fileName?.replace(/\.(json|csv|tsv|txt)$/i, '') ?? (kind === 'url' && url ? new URL(url).hostname : 'Data');
      const out = await addSource({ name: name.trim() || fallback, ...(kind === 'url' ? { url: url.trim(), allowLocal: local } : { text: body ?? text }), path });
      setNote(out.reran.length
        ? t.n(out.reran.length, '{records} records in {name}. {count} template ran again.', '{records} records in {name}. {count} templates ran again.', { records: out.source.records.length, name: out.source.name })
        : t('{count} records in {name}. Bind a layer to it in the inspector.', { count: out.source.records.length, name: out.source.name }));
      setText('');
      setName('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.csv,.tsv,.txt,application/json,text/csv';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file) void file.text().then((t) => add(t, file.name));
    };
    input.click();
  };

  return (
    <div className="data-add" data-testid="data-add">
      <span className="panel-title">{t('Add a source')}</span>
      <Segmented<AddKind> value={kind} onChange={setKind} testId="data-add-kind" options={[{ value: 'paste', label: t('Paste'), title: t('Paste JSON or CSV') }, { value: 'upload', label: t('Upload'), title: t('A JSON or CSV file') }, { value: 'url', label: t('URL'), title: t('An address that returns JSON or CSV') }]} />
      <input className="token-input" placeholder={t('Name, such as Products')} dir="auto" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="data-name" />
      {kind === 'paste' ? <textarea className="repeat-data" rows={4} placeholder={'[{ "name": "Lamp", "price": 49 }]'} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="data-text" /> : null}
      {kind === 'url' ? (
        <>
          <input className="token-input" placeholder="https://api.example.com/items" value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="data-url" />
          <label className="import-check" title={t('A dev server or a device at home. Only a request from this computer reaches it, never an agent\'s.')}><input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} data-testid="data-local" /> {t('Allow this computer\'s network (only from this device)')}</label>
        </>
      ) : null}
      <input className="token-input" placeholder={t('Where the list is, such as {path}', { path: 'data.items' })} value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.stopPropagation()} data-testid="data-path" />
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => (kind === 'upload' ? upload() : void add())} data-testid="data-add-run"><Plus size={14} /> {busy ? t('Reading') : kind === 'upload' ? t('Choose a file') : t('Add')}</button>
      {note ? <div className="hint" data-testid="data-note">{note}</div> : null}
      {error ? <div className="error" data-testid="data-add-error">{error}</div> : null}
    </div>
  );
}

/** The file's data: named record lists that templates repeat over and refresh from. */
export function DataPanel() {
  const t = useT();
  const sources = useDataSources();
  return (
    <div className="data-panel" data-testid="data-panel">
      <div className="panel-scroll">
        {sources.length ? sources.map((src) => <SourceRow key={src.id} source={src} />) : <Empty title={t('No data yet')} hint={t('Add records here, then bind a layer to their fields in the inspector. Each record makes a copy.')} />}
        <AddSource />
      </div>
    </div>
  );
}
