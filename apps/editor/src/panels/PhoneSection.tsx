import { useCallback, useEffect, useMemo, useState } from 'react';
import { qrMatrix, qrSvgPath } from '@bogen/core';
import { onServerEvent } from '../lib/events.ts';
import { phoneOrigin } from '../lib/phone.ts';
import { editor } from '../state/store.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

interface PhoneDevice { id: string; name: string; pairedAt: number; seenAt: number | null }
interface PhoneState {
  on: boolean; listening: boolean; url: string | null; httpsPort: number; logins: string[]; serve: 'ours' | 'free' | 'taken' | 'unknown';
  devices: PhoneDevice[]; serveCommand: string; served?: { state: string; message: string } | null;
}

function ago(at: number | null): string {
  if (!at) return t('never');
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return t('just now');
  if (s < 3600) return t.n(Math.round(s / 60), '{count} min ago', '{count} min ago');
  if (s < 86400) return t.n(Math.round(s / 3600), '{count} h ago', '{count} h ago');
  return t.n(Math.round(s / 86400), '{count} d ago', '{count} d ago');
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? t('{method} {path} failed with {status}', { method, path, status: res.status }));
  return data;
}

function Qr({ text }: { text: string }) {
  const t = useT();
  const { size, d } = useMemo(() => qrSvgPath(qrMatrix(text)), [text]);
  return (
    <div className="phone-qr" data-testid="phone-qr" title={text}>
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={t('QR code for {address}', { address: text })} shapeRendering="crispEdges"><path d={d} fill="#000" /></svg>
    </div>
  );
}

/** The phone listener: on or off, its address, a pairing code with its QR, and the paired phones. Only on the computer. */
export function PhoneSection() {
  const t = useT();
  const [state, setState] = useState<PhoneState | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number; url: string | null; before: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => void call<PhoneState>('GET', '/api/phone').then(setState, () => setState(null)), []);
  useEffect(() => {
    load();
    return onServerEvent((e) => { if (e.t === 'phone') load(); });
  }, [load]);
  // A code is spent once a phone has used it, and dead after ten minutes: either way it leaves the screen.
  const count = state?.devices.length ?? 0;
  useEffect(() => {
    if (!pairing) return;
    if (count > pairing.before) return setPairing(null);
    const timer = window.setTimeout(() => setPairing(null), Math.max(0, pairing.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pairing, count]);

  if (phoneOrigin || !state) return null;
  const fail = (e: Error) => editor().showToast(e.message);
  const turn = (on: boolean) => {
    setBusy(true);
    void call<PhoneState>('POST', '/api/phone', { on }).then((next) => {
      setState(next);
      if (next.served && next.served.state !== 'added' && next.served.state !== 'removed') editor().showToast(next.served.message);
    }, fail).finally(() => setBusy(false));
  };
  const pair = () => void call<{ code: string; expiresAt: number; url: string | null }>('POST', '/api/phone/code').then((p) => setPairing({ ...p, before: count }), fail);
  const remove = (d: PhoneDevice) => void call('DELETE', `/api/phone/devices/${d.id}`).then(load, fail);

  return (
    <div className="section-plain" data-testid="phone-section">
      <div className="feed-title">{t('Phone')}</div>
      {!state.on ? (
        <>
          <div className="hint">{t('Off. Turned on, your phone opens Bogen through Tailscale at its own address, and keeps files to use offline.')}</div>
          <div className="phone-actions"><button type="button" className="run-link" disabled={busy} onClick={() => turn(true)} data-testid="phone-on">{t('Turn on')}</button></div>
        </>
      ) : (
        <>
          <div className="phone-row"><span className={`sync-dot${state.listening && state.serve === 'ours' ? ' is-on' : ''}`} />{state.listening ? t('On') : t('On, not listening')}<span className="hint">{state.serve === 'ours' ? t('{command} is set', { command: 'tailscale serve' }) : state.serve === 'taken' ? t('https port {port} is taken', { port: state.httpsPort }) : state.serve === 'free' ? t('{command} is not set', { command: 'tailscale serve' }) : ''}</span></div>
          {state.url ? <div className="phone-url" data-testid="phone-url">{state.url}</div> : <div className="hint">{t('Waiting for Tailscale to say this computer\'s name.')}</div>}
          {state.serve === 'free' ? <div className="sync-warn">{t('Run: {command}', { command: state.serveCommand })}</div> : null}
          {pairing && pairing.url ? (
            <>
              <Qr text={`${pairing.url}#/pair/${pairing.code}`} />
              <div className="phone-code" data-testid="phone-code">{pairing.code}</div>
              <div className="hint">{t('Scan with the phone\'s camera, add Bogen to the Home Screen, open it there and type this code. It works once, for ten minutes.')}</div>
            </>
          ) : state.url ? <Qr text={state.url} /> : null}
          {state.devices.map((d) => (
            <div key={d.id} className="phone-row" data-testid="phone-device">
              <span dir="auto">{d.name}</span><span className="hint">{t('seen {when}', { when: ago(d.seenAt) })}</span>
              <button type="button" className="run-link" onClick={() => remove(d)} data-testid="phone-remove" title={t('Its token stops working at once')}>{t('Remove')}</button>
            </div>
          ))}
          <div className="phone-actions">
            <button type="button" className="run-link" onClick={pair} data-testid="phone-pair">{t('Pair a phone')}</button>
            <button type="button" className="run-link" disabled={busy} onClick={() => turn(false)} data-testid="phone-off">{t('Turn off')}</button>
          </div>
        </>
      )}
    </div>
  );
}
