import { useCallback, useEffect, useState } from 'react';
import { onServerEvent } from '../lib/events.ts';
import { editor } from '../state/store.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

interface Allowed { deviceId: string; device: string; allowed: boolean; connected: boolean }

async function asJson<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error ?? t('The server answered {status}.', { status: res.status }));
  return body as T;
}

/**
 * On the computer with the CLIs: which paired devices may ask its agents. Off for each device until its owner
 * turns it on here; the server refuses this anywhere but at this machine, so a phone or another device sees nothing.
 */
export function RemoteRunsSection() {
  const t = useT();
  const [list, setList] = useState<Allowed[] | null>(null);
  const load = useCallback(() => void fetch('/api/runs/remote/allow').then((r) => asJson<Allowed[]>(r)).then(setList, () => setList(null)), []);
  useEffect(() => {
    load();
    return onServerEvent((e) => {
      if (e.t === 'peers') load();
    });
  }, [load]);
  if (!list?.length) return null;
  const set = async (deviceId: string, allow: boolean) => {
    try {
      setList(await asJson<Allowed[]>(await fetch('/api/runs/remote/allow', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, allow }) })));
    } catch (err) {
      editor().showToast((err as Error).message);
    }
  };
  return (
    <div className="section-plain" data-testid="remote-runs">
      <div className="feed-title">{t('Other devices')}</div>
      <p className="hint">{t("A device you allow can ask claude and codex on this computer from its {shortcut} bar. The run happens here, on your plan, in this computer's copy of the file, and its changes sync back.", { shortcut: 'Ctrl+K' })}</p>
      {list.map((d) => (
        <label key={d.deviceId} className="agent-follow" data-testid="remote-runs-device">
          <input type="checkbox" checked={d.allowed} onChange={(e) => void set(d.deviceId, e.target.checked)} data-testid="remote-runs-allow" />
          <span>{d.connected ? t('{device} may ask agents here', { device: d.device }) : t('{device} may ask agents here (not connected now)', { device: d.device })}</span>
        </label>
      ))}
    </div>
  );
}
