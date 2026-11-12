import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { IconButton, TextField } from '../ui/controls.tsx';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

/**
 * "Update the other device": `bogen peer deploy <ssh-host>` from this machine, for a paired device that runs another
 * build (packages/server/src/peer-deploy.ts). A dry run shows what would change; only then does Update run it.
 */

interface DeployInfo {
  available: boolean;
  peer: { id: string; name: string; version: string | null; state: 'connected' | 'offline' };
  version: string;
  order: 'same' | 'newer' | 'older' | 'apart' | 'unknown';
  host: string;
  hostSaved: boolean;
  command: string;
  running: boolean;
}

interface DeployResult { code: number; output: string; dryRun: boolean; host: string; plan?: string; command: string }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({})) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? t('The server answered {status}.', { status: res.status }));
  return body;
}

/** What the order of the two builds means for the person, in a sentence. Exported for tests. */
export function orderWords(order: DeployInfo['order'], name: string): string {
  switch (order) {
    case 'newer': return t('This computer\'s build is newer. Updating brings {name} up to it.', { name });
    case 'older': return t('{name} has the newer build. Updating it would put this older one there. Update this computer from {name} instead.', { name });
    case 'same': return t('{name} already runs this build.', { name });
    case 'apart': return t('The two builds come from different lines of work. Updating copies this one there.');
    default: return t('Which build is newer cannot be told from here. Updating copies this one there.');
  }
}

export function PeerDeployDialog({ peerId, onClose }: { peerId: string; onClose: () => void }) {
  const t = useT();
  const [info, setInfo] = useState<DeployInfo | null>(null);
  const [host, setHost] = useState('');
  const [result, setResult] = useState<DeployResult | null>(null);
  const [plan, setPlan] = useState<{ plan: string; host: string } | null>(null);
  const [busy, setBusy] = useState<'dry' | 'real' | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void call<DeployInfo>(`/api/peers/${encodeURIComponent(peerId)}/deploy`).then((i) => {
      setInfo(i);
      setHost(i.host);
    }, (e: Error) => setError(e.message));
  }, [peerId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [busy, onClose]);

  const run = (dryRun: boolean) => {
    setBusy(dryRun ? 'dry' : 'real');
    setError('');
    void call<DeployResult>(`/api/peers/${encodeURIComponent(peerId)}/deploy`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, dryRun, ...(dryRun ? {} : { plan: plan?.plan }) }),
    }).then((r) => {
      setResult(r);
      setPlan(r.dryRun && r.plan ? { plan: r.plan, host: r.host } : null);
    }, (e: Error) => setError(e.message)).finally(() => setBusy(null));
  };

  const name = info?.peer.name ?? t('the other device');
  const ready = plan !== null && plan.host === host.trim();
  return (
    <div className="dialog-scrim" data-ui onPointerDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="dialog settings peer-deploy" role="dialog" aria-modal="true" aria-label={t('Update {name}', { name })} data-testid="peer-deploy">
        <header className="dialog-head settings-head">
          <span className="settings-title">{t('Update {name}', { name })}</span>
          <IconButton icon={<X size={14} />} title={t('Close ({shortcut})', { shortcut: 'Esc' })} onClick={() => { if (!busy) onClose(); }} testId="peer-deploy-close" />
        </header>
        <div className="settings-body">
          {info ? (
            <>
              <p className="settings-hint peer-deploy-pad" data-testid="peer-deploy-versions">
                {info.peer.version ? t('{name} runs {version}.', { name, version: info.peer.version }) : t('{name} runs an older build that does not say its version.', { name })} {t('This computer runs {version}.', { version: info.version })} {orderWords(info.order, name)}
              </p>
              {info.available ? (
                <>
                  <div className="settings-row">
                    <div><div className="settings-name">{t('SSH host')}</div><div className="settings-hint">{t.rich('How this computer reaches {name} with ssh, such as {example} or a Host from {config}. It needs a key, since nothing can ask for a password here.', { name, example: <code>me@100.64.0.12</code>, config: '~/.ssh/config' })}</div></div>
                    <div className="settings-control"><TextField value={host} onChange={setHost} live testId="peer-deploy-host" /></div>
                  </div>
                  <p className="settings-hint peer-deploy-pad">
                    {t.rich('It copies this build and the Omarchy integration to {name} over ssh and restarts Bogen there: {command}. Designs there are not touched.', { name, command: <code>{`bogen peer deploy ${host || '<ssh-host>'}`}</code> })}
                    {' '}{t('The dry run looks first and changes nothing on either computer.')}
                  </p>
                  <div className="peer-deploy-actions">
                    <button type="button" className="btn" disabled={!host.trim() || busy !== null} onClick={() => run(true)} data-testid="peer-deploy-dry">{busy === 'dry' ? t('Looking') : t('Dry run')}</button>
                    <button type="button" className="btn btn-primary" disabled={!ready || busy !== null} title={ready ? undefined : t('Run the dry run for this host first')} onClick={() => run(false)} data-testid="peer-deploy-run">{busy === 'real' ? t('Updating') : t('Update {name}', { name })}</button>
                  </div>
                </>
              ) : (
                <p className="settings-hint peer-deploy-pad" data-testid="peer-deploy-unavailable">{t.rich('This install has no deploy script. In a terminal, from a checkout of Bogen, run {command}.', { command: <code>{info.command}</code> })}</p>
              )}
              {result ? (
                <div className="peer-deploy-result" data-testid="peer-deploy-result" data-code={result.code} data-dry={result.dryRun ? 'yes' : 'no'}>
                  <div className={`settings-name${result.code ? ' sync-warn' : ''}`}>
                    {result.code ? (result.dryRun ? t('The dry run stopped (exit {code}).', { code: result.code }) : t('The update stopped (exit {code}).', { code: result.code })) : result.dryRun ? t('Dry run done. Nothing changed. This is what Update would do:') : t('Done. {name} restarted with this build.', { name })}
                  </div>
                  <pre className="peer-deploy-output">{result.output.trim() || t('(no output)')}</pre>
                </div>
              ) : null}
            </>
          ) : <p className="settings-hint peer-deploy-pad">{error || t('Asking the server.')}</p>}
          {info && error ? <p className="sync-warn peer-deploy-pad" role="alert">{error}</p> : null}
        </div>
      </div>
    </div>
  );
}
