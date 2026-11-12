import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Upload, X } from 'lucide-react';
import { IconButton } from '../ui/controls.tsx';
import '../styles/transfer.css';
import { t } from '../i18n/store.ts';
import { useT } from '../i18n/react.ts';

/** Sends a `.bogen` file to the server and gives what it became. */
export async function importBogenFile(file: File): Promise<{ id: string; name: string }> {
  const res = await fetch('/api/files/import', {
    method: 'POST',
    // The name goes through a header, so it has to survive being one.
    headers: { 'Content-Type': 'application/x-bogen', 'X-Bogen-Filename': file.name.replace(/[^\x20-\x7e]/g, '_') },
    body: file,
  });
  const body = await res.json().catch(() => ({})) as { id?: string; name?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? t('Opening {file} failed with {status}.', { file: file.name, status: res.status }));
  return { id: body.id, name: body.name ?? file.name };
}

/** Takes files dropped anywhere on the home screen. */
export function DropZone({ onFiles, children }: { onFiles: (files: File[]) => void; children: ReactNode }) {
  const t = useT();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  return (
    <div
      className={`home-drop${over ? ' is-over' : ''}`}
      data-testid="home-drop"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      }}
      onDrop={(e) => {
        depth.current = 0;
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (!files.length) return;
        e.preventDefault();
        onFiles(files);
      }}
    >
      {children}
      {over ? <div className="home-drop-hint" data-testid="home-drop-hint"><Upload size={16} /> {t('Drop a {extension} file to open it', { extension: '.bogen' })}</div> : null}
    </div>
  );
}

interface FigmaReport { fileId: string; name: string; pages: { name: string }[]; layers: number; images: number; vectors: number; fonts: string[]; unsupported: { what: string; count: number; example: string }[]; failed: string[] }

/** Import through Figma's REST API with the person's own token. */
export function FigmaDialog({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const t = useT();
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [save, setSave] = useState(false);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<FigmaReport | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
    void fetch('/api/config/figma').then((r) => (r.ok ? r.json() : null)).then((b: { saved?: boolean; env?: boolean } | null) => setSaved(Boolean(b?.saved || b?.env))).catch(() => {});
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/import/figma', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), ...(token.trim() ? { token: token.trim() } : {}), ...(save && token.trim() ? { saveToken: true } : {}) }),
      });
      const body = await res.json().catch(() => ({})) as FigmaReport & { error?: string };
      if (!res.ok) throw new Error(body.error ?? t('The import failed with {status}.', { status: res.status }));
      setReport(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog import-dialog" role="dialog" aria-label={t('Import from Figma')} data-testid="figma-dialog" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <header className="dialog-head">
          <span className="import-title">{t('Import from Figma')}</span>
          <IconButton icon={<X size={14} />} title={t('Close')} onClick={onClose} />
        </header>
        <div className="dialog-body import-body">
          {report ? (
            <div data-testid="figma-report">
              <p dir="auto">{t('"{name}": {pages} pages, {layers} layers, {images} images, {vectors} vectors.', { name: report.name, pages: report.pages.length, layers: report.layers, images: report.images, vectors: report.vectors })}</p>
              {report.fonts.length ? <p className="hint">{t('Fonts by name: {fonts}. Google Fonts load by themselves. Others need to be on this machine.', { fonts: report.fonts.join(', ') })}</p> : null}
              {report.unsupported.length ? <><p className="hint">{t('Not exact:')}</p>{report.unsupported.map((u) => <p key={u.what} className="hint">{t('{what} ({count}, such as "{example}")', { what: u.what, count: u.count, example: u.example })}</p>)}</> : null}
              {report.failed.length ? <><p className="error">{t('Failed:')}</p>{report.failed.slice(0, 10).map((f) => <p key={f} className="error">{f}</p>)}</> : null}
              <button type="button" className="btn btn-primary" onClick={() => onOpened(report.fileId)} data-testid="figma-open">{t('Open the file')}</button>
            </div>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void run(); }} className="import-form">
              <label className="import-field">
                <span>{t('File or frame link')}</span>
                <input ref={first} className="token-input" value={url} placeholder="https://www.figma.com/design/..." onChange={(e) => setUrl(e.target.value)} data-testid="figma-url" />
              </label>
              <label className="import-field">
                <span>{saved ? t('Personal access token, or leave empty to use the saved one') : t('Personal access token')}</span>
                <input className="token-input" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} data-testid="figma-token" />
              </label>
              <p className="hint">{t('Make one in Figma under Settings, Security, with the {scope} scope. It goes to Figma only.', { scope: 'file_content:read' })}</p>
              <label className="import-check"><input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} data-testid="figma-save" /><span>{t('Remember it on this computer, in a file only you can read')}</span></label>
              {error ? <div className="error" data-testid="figma-error">{error}</div> : null}
              <div className="import-actions">
                <button type="button" className="btn btn-quiet" onClick={onClose}>{t('Cancel')}</button>
                <button type="submit" className="btn btn-primary" disabled={busy || !url.trim()} data-testid="figma-run">{busy ? t('Importing') : t('Import')}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
