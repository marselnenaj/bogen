import { useCallback, useEffect, useState } from 'react';
import { agentApi, type PeerDetail, type SyncConflict } from '../lib/agent-api.ts';
import { api } from '../lib/api.ts';
import { onServerEvent } from '../lib/events.ts';
import { canUseOther, useOther } from '../ops/conflicts.ts';
import { phoneOrigin } from '../lib/phone.ts';
import { PeerDeployDialog } from './PeerDeploy.tsx';
import { jumpToLayers } from '../ops/jump.ts';
import { saveShareCursors, useRunSettings } from './RunChoice.tsx';
import { editor, useEditor } from '../state/store.ts';
import { useT } from '../i18n/react.ts';
import { t } from '../i18n/store.ts';

function ago(at: number | null | undefined): string {
  if (!at) return t('not yet');
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return t('just now');
  if (s < 3600) return t.n(Math.round(s / 60), '{count} min ago', '{count} min ago');
  if (s < 86400) return t.n(Math.round(s / 3600), '{count} h ago', '{count} h ago');
  return t.n(Math.round(s / 86400), '{count} d ago', '{count} d ago');
}

function ConflictRow({ conflict, onDone }: { conflict: SyncConflict; onDone: () => void }) {
  const t = useT();
  const fileId = conflict.fileId;
  const dismiss = () => void agentApi.dismissConflict(fileId, conflict.id).then(onDone);
  // The text that was not kept goes into a branch of the file, and the note with it.
  const branch = () => void agentApi.branchConflict(fileId, conflict.id).then((b) => {
    editor().showToast(t('Made the branch "{name}". Its text is the one that was not kept.', { name: b.name }));
    onDone();
  }, (err: Error) => editor().showToast(err.message));
  return (
    <div className="conflict" data-testid="conflict">
      <button type="button" className="run-link conflict-name" dir="auto" onClick={() => { if (conflict.nodeId) jumpToLayers([conflict.nodeId]); }}>{conflict.name || conflict.nodeId} · {conflict.field.replace(/^style\./, '')}</button>
      <div className="conflict-values">
        <span className={conflict.kept === 'ours' ? 'is-kept' : ''} title={conflict.texts ? t("This device's text") : t('The value on this device')} dir="auto">{t('Here: {value}', { value: conflict.ours })}</span>
        <span className={conflict.kept === 'theirs' ? 'is-kept' : ''} title={conflict.texts ? t('The text on {device}', { device: conflict.device }) : t('The value on {device}', { device: conflict.device })} dir="auto">{conflict.device}: {conflict.theirs}</span>
      </div>
      <div className="conflict-foot">
        <span className="hint">{conflict.kept === 'ours' ? t('Kept the one here, {time}', { time: ago(conflict.at) }) : t('Kept the one from {device}, {time}', { device: conflict.device, time: ago(conflict.at) })}</span>
        {canUseOther(conflict) ? <button type="button" className="run-link" data-testid="conflict-use" onClick={() => { useOther(conflict); dismiss(); }}>{t('Use the other')}</button> : null}
        {conflict.texts ? <button type="button" className="run-link" data-testid="conflict-branch" title={t('Keeps the text that is shown, and puts the other in a branch of this file')} onClick={branch}>{t('Keep both as a branch')}</button> : null}
        <button type="button" className="run-link" data-testid="conflict-dismiss" onClick={dismiss}>{t('Dismiss')}</button>
      </div>
    </div>
  );
}

function PeerRow({ peer, fileId }: { peer: PeerDetail; fileId: string | null }) {
  const t = useT();
  const here = peer.here?.find((h) => h.fileId === fileId);
  const [deploying, setDeploying] = useState(false);
  return (
    <div className="sync-peer" data-testid="sync-peer">
      <div className="sync-peer-line"><span className={`sync-dot${peer.state === 'connected' ? ' is-on' : ''}`} />{peer.name}<span className="hint">{peer.state === 'connected' ? t('synced {time}', { time: ago(peer.lastSyncAt) }) : t('offline, last sync {time}', { time: ago(peer.lastSyncAt) })}</span></div>
      {here ? <div className="hint" data-testid="sync-peer-here">{here.people.map((p) => (p.selection ? t.n(p.selection, '{name} has this file open, {count} selected', '{name} has this file open, {count} selected', { name: p.name }) : t('{name} has this file open', { name: p.name }))).join('; ')}</div> : null}
      {peer.versionMismatch ? (
        <div className="sync-warn" data-testid="sync-peer-version">
          {t('It runs {version}.', { version: peer.version ?? '' })}{' '}
          {phoneOrigin ? t('Update it from the computer.') : <button type="button" className="run-link" onClick={() => setDeploying(true)} data-testid="sync-peer-update">{t('Update {device}', { device: peer.name })}</button>}
        </div>
      ) : null}
      {deploying ? <PeerDeployDialog peerId={peer.id} onClose={() => setDeploying(false)} /> : null}
      {peer.error ? <div className="sync-warn">{peer.error}</div> : null}
    </div>
  );
}

/** The other devices, and what they disagreed about. Nothing at all with no devices. */
export function SyncSection() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const data = useRunSettings();
  const [peers, setPeers] = useState<PeerDetail[]>([]);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const load = useCallback(() => {
    void api.status().then((st) => setPeers((st.peers ?? []) as PeerDetail[]), () => {});
    if (fileId) void agentApi.conflicts(fileId).then(setConflicts, () => {});
  }, [fileId]);
  useEffect(() => {
    load();
    return onServerEvent((e) => {
      if (e.t === 'peers' || (e.t === 'sync-conflicts' && e.fileId === fileId)) load();
    });
  }, [load, fileId]);
  if (!peers.length && !conflicts.length) return null;
  const share = data?.settings.shareCursors ?? false;
  return (
    <div className="section-plain" data-testid="sync-section">
      <div className="feed-title">{t('Sync')}</div>
      {peers.map((p) => <PeerRow key={p.id} peer={p} fileId={fileId} />)}
      {peers.length ? (
        <label className="agent-follow" title={t('Which file and layers you have selected always show on your other devices. Your cursor only with this on.')}>
          <input type="checkbox" checked={share} data-testid="share-cursors" onChange={(e) => void saveShareCursors(e.target.checked).catch((err: Error) => editor().showToast(err.message))} />
          <span>{t('Show my cursor on my other devices')}</span>
        </label>
      ) : null}
      {conflicts.length ? <div className="hint">{t('Both sides set these while apart:')}</div> : null}
      {conflicts.map((c) => <ConflictRow key={c.id} conflict={c} onDone={load} />)}
    </div>
  );
}
