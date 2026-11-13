import { useCallback, useEffect, useState } from 'react';
import { onServerEvent } from '../lib/events.ts';
import { useT } from '../i18n/react.ts';
import { formatDate, formatDateTime } from '../i18n/format.ts';
import '../styles/browser-capture.css';

/** A browser extension asking to pair, as the server shows it: no secrets. */
interface PairRequest { id: string; code: string; origin: string; name: string; expiresAt: number }
interface Pairing { id: string; name: string; origin: string; pairedAt: number; usedAt: number | null }

async function call<T>(method: string, path: string): Promise<T> {
  const res = await fetch(path, { method });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? String(res.status));
  return data;
}

/**
 * The person approves a browser extension once, here, after comparing the code it shows. Only on this computer: the
 * server answers these routes for nobody else, so elsewhere this stays empty.
 */
export function ExtensionApproval() {
  const t = useT();
  const [requests, setRequests] = useState<PairRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => void call<PairRequest[]>('GET', '/api/extension/requests').then(setRequests, () => setRequests([])), []);
  useEffect(() => {
    load();
    return onServerEvent((e) => { if (e.t === 'extension') load(); });
  }, [load]);
  const request = requests[0];
  useEffect(() => {
    if (!request) return;
    const timer = window.setTimeout(load, Math.max(0, request.expiresAt - Date.now()) + 500);
    return () => clearTimeout(timer);
  }, [request, load]);
  if (!request) return null;
  const decide = async (allow: boolean) => {
    setBusy(true);
    setError('');
    try {
      await call('POST', `/api/extension/requests/${request.id}/${allow ? 'approve' : 'deny'}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dialog-scrim extension-scrim" data-ui>
      <div className="dialog extension-approve" role="alertdialog" aria-modal="true" aria-labelledby="extension-approve-title" data-testid="extension-approve">
        <h2 id="extension-approve-title">{t('Allow the browser extension?')}</h2>
        <p className="extension-dim">{t('A browser extension asks to send captures to this Bogen. Allow it only if it shows this code.')}</p>
        <div className="extension-code" data-testid="extension-code">{request.code}</div>
        <dl className="extension-facts">
          <dt>{t('Name')}</dt><dd dir="auto">{request.name}</dd>
          <dt>{t('From')}</dt><dd className="extension-origin">{request.origin}</dd>
          <dt>{t('It can')}</dt><dd>{t('Add captured pages to your files. Nothing else: it cannot read, change or delete your designs.')}</dd>
        </dl>
        {error ? <p className="extension-error" role="alert">{error}</p> : null}
        <footer className="extension-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void decide(false)} data-testid="extension-deny">{t('Deny')}</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void decide(true)} data-testid="extension-allow" autoFocus>{t('Allow')}</button>
        </footer>
      </div>
    </div>
  );
}

/** Settings, Privacy: the paired extensions, each with Revoke. */
export function ExtensionSection() {
  const t = useT();
  const [pairings, setPairings] = useState<Pairing[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => void call<Pairing[]>('GET', '/api/extension/pairings').then((p) => { setPairings(p); setError(''); }, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    load();
    return onServerEvent((e) => { if (e.t === 'extension') load(); });
  }, [load]);
  const revoke = (id: string) => void call('DELETE', `/api/extension/pairings/${id}`).then(load, (e: Error) => setError(e.message));
  return (
    <section className="extension-section" data-testid="setting-extensions">
      <div className="settings-name">{t('Browser extensions')}</div>
      <p className="settings-hint">{t('Paired extensions can add captured pages to your files, and nothing else. Load the extension from integrations/browser-extension, then pair it from its popup.')}</p>
      {error ? <p className="settings-hint" role="alert">{error}</p> : null}
      {pairings && !pairings.length ? <p className="settings-hint">{t('No extension is paired')}</p> : null}
      {pairings?.map((p) => (
        <div key={p.id} className="extension-row" data-testid="extension-pairing">
          <div className="extension-row-text">
            <strong dir="auto">{p.name}</strong>
            <span className="settings-hint">{p.usedAt ? t('Paired {date}, last capture {when}', { date: formatDate(p.pairedAt), when: formatDateTime(p.usedAt) }) : t('Paired {date}, never used', { date: formatDate(p.pairedAt) })}</span>
          </div>
          <button type="button" className="btn extension-revoke" onClick={() => revoke(p.id)} data-testid="extension-revoke">{t('Revoke')}</button>
        </div>
      ))}
    </section>
  );
}
