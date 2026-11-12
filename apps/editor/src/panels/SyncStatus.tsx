import { useEffect, useState } from 'react';
import { api, type PeerInfo } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { phoneOrigin } from '../lib/phone.ts';
import { useEditor } from '../state/store.ts';
import { PeerDeployDialog } from './PeerDeploy.tsx';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

function ago(at: number | null): string {
  if (!at) return t('not yet');
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 10) return t('just now');
  if (seconds < 60) return t.n(seconds, '{count} s ago', '{count} s ago');
  if (seconds < 3600) return t.n(Math.round(seconds / 60), '{count} min ago', '{count} min ago');
  if (seconds < 86400) return t.n(Math.round(seconds / 3600), '{count} h ago', '{count} h ago');
  return t.n(Math.round(seconds / 86400), '{count} d ago', '{count} d ago');
}

function describe(p: PeerInfo): string {
  const parts = [p.state === 'connected' ? t('{name}: connected', { name: p.name }) : t('{name}: offline', { name: p.name }), t('last sync {time}', { time: ago(p.lastSyncAt) })];
  if (p.pending) parts.push(t.n(p.pending, '{count} waiting', '{count} waiting'));
  if (p.versionMismatch) parts.push(t('it runs another version, {version}. Click to update it', { version: String(p.version) }));
  if (p.error) parts.push(p.error);
  return parts.join(', ');
}

/** The other devices this Bogen syncs with, kept current. The toolbar reads it to make room for their state. */
export function useSyncPeers(): PeerInfo[] {
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  useEffect(() => {
    const load = () => { api.status().then((s) => setPeers(s.peers ?? []), () => {}); };
    load();
    const off = onServerEvent((e) => { if (e.t === 'peers') load(); });
    // Also keeps the "last sync" in the tooltip from going stale.
    const timer = window.setInterval(load, 30_000);
    return () => { off(); clearInterval(timer); };
  }, []);
  return peers;
}

/** The other devices this Bogen syncs with. Nothing at all when there are none. */
export function SyncStatus({ peers }: { peers: PeerInfo[] }) {
  const t = useT();
  const [deploying, setDeploying] = useState<string | null>(null);
  const fileId = useEditor((s) => s.fileId);
  if (!peers.length) return null;
  const up = peers.filter((p) => p.state === 'connected');
  const first = up[0] ?? peers[0]!;
  const more = peers.length > 1 ? ` +${peers.length - 1}` : '';
  const stale = peers.find((p) => p.versionMismatch);
  const here = peers.flatMap((p) => p.here?.filter((h) => h.fileId === fileId).flatMap((h) => h.people.map((who) => (who.selection ? t('{name} on {device}, {selection} selected', { name: who.name, device: p.name, selection: who.selection }) : t('{name} on {device}', { name: who.name, device: p.name })))) ?? []);
  const title = [...peers.map(describe), ...here.map((line) => t('In this file: {line}', { line }))].join('\n');
  // Another build over there: the indicator offers to update it from here. The phone app has no way to.
  if (stale && !phoneOrigin) {
    return (
      <>
        <button type="button" className={`sync-status is-warn is-button${up.length ? ' is-connected' : ''}`} title={title} data-testid="sync-status" data-warn="version" onClick={() => setDeploying(stale.id)}>
          <span className="sync-dot" />
          <span className="sync-name">{t('{name}: other version', { name: stale.name })}</span>
          <span className="sync-update" data-testid="sync-update">{t('Update the other device')}</span>
        </button>
        {deploying ? <PeerDeployDialog peerId={deploying} onClose={() => setDeploying(null)} /> : null}
      </>
    );
  }
  return (
    <span className={`sync-status${up.length ? ' is-connected' : ''}${stale ? ' is-warn' : ''}`} title={title} data-testid="sync-status" data-warn={stale ? 'version' : undefined}>
      <span className="sync-dot" />
      <span className="sync-name">{stale ? t('{name}: other version', { name: stale.name }) : `${first.name}${more}`}</span>
      {here.length && !stale ? <span className="sync-here" data-testid="sync-here">{t('in this file')}</span> : null}
    </span>
  );
}
