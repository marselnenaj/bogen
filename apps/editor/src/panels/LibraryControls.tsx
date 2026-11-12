import { useEffect, useState } from 'react';
import { isLibraryParent, libraryInfo, unpublishedChanges } from '@bogen/core';
import { Library } from 'lucide-react';
import { useSnapVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { onServerEvent } from '../lib/events.ts';
import { acceptHere, kitApi, libraryApi, linkHere, publishHere, unlinkHere, useKitHere, type KitInfo, type LibraryStatus } from '../ops/library.ts';
import { useEditor } from '../state/store.ts';
import { useLibraryUpdates } from './LibraryBanner.tsx';
import { useT } from '../i18n/react.ts';

/** The foot of the assets panel: publish this file's components, link other files' libraries. */
export function LibraryControls() {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const [status, setStatus] = useState<LibraryStatus | null>(null);
  const [tick, setTick] = useState(0);
  const [kits, setKits] = useState<KitInfo[]>([]);
  const { updates } = useLibraryUpdates();
  useSnapVersion();
  useEffect(() => onServerEvent((e) => {
    if (e.t === 'library' || e.t === 'files') setTick((n) => n + 1);
  }), []);
  useEffect(() => {
    if (!fileId) return;
    let live = true;
    void libraryApi.status(fileId).then((s) => { if (live) setStatus(s); }, () => {});
    return () => { live = false; };
  }, [fileId, tick]);
  useEffect(() => {
    let live = true;
    void kitApi.list().then((k) => { if (live) setKits(k); }, () => {});
    return () => { live = false; };
  }, []);
  // What this editor just wrote reaches the server's copy a moment later.
  const later = () => window.setTimeout(() => setTick((n) => n + 1), 400);
  if (!status) return null;
  const { snap, doc } = session();
  // From this editor's own document, so that an edit to a main shows here at once.
  const own = libraryInfo(doc);
  const pending = own ? unpublishedChanges(doc).length : 0;
  const hasOwn = [...snap.mains].some((id) => !isLibraryParent(snap.nodes.stored(id)?.parent));
  // A kit's library file is listed as a kit, not again among the libraries to link.
  const kitNames = new Set(kits.map((k) => k.name));
  const linkedNames = new Set(status.linked.map((l) => l.name));
  const available = status.available.filter((l) => !kitNames.has(l.name));
  if (!hasOwn && !own && !status.linked.length && !available.length && !kits.length) return null;
  return (
    <div className="library-controls" data-testid="library-controls">
      <div className="asset-group-title"><Library size={13} /> {t('Libraries')}</div>
      {hasOwn || own ? <div className="library-row">
        <span className="library-name" dir="auto">{own ? t('Published as {name}', { name: own.name }) : t('This file')}</span>
        <button type="button" className="btn" data-testid="library-publish" title={t("Offer this file's components to other files. They see an update to accept.")} onClick={() => { publishHere(own?.name); later(); }}>
          {own ? (pending ? t.n(pending, 'Publish {count} change', 'Publish {count} changes') : t('Published')) : t('Publish')}
        </button>
      </div> : null}
      {status.linked.map((l) => {
        const mine = updates.filter((u) => u.lib === l.id).length;
        return (
          <div key={l.id} className="library-row" data-testid="library-linked" data-library={l.id}>
            <span className="library-name" dir="auto" title={l.missing ? t('Not on this device any more. Instances show the copies this file keeps.') : undefined}>{l.missing ? t('{name} (missing)', { name: l.name }) : l.name}</span>
            {mine ? <button type="button" className="btn" data-testid="library-update" onClick={() => { void acceptHere(l.id).then(later); }}>{t('Update {count}', { count: mine })}</button> : null}
            <button type="button" className="btn" title={t('Unlink. Instances keep what they show.')} onClick={() => { unlinkHere(l.id); later(); }}>{t('Unlink')}</button>
          </div>
        );
      })}
      {available.map((l) => (
        <div key={l.id} className="library-row" data-testid="library-available" data-library={l.id}>
          <span className="library-name" dir="auto" title={t.n(l.components.length, '{count} component(s) from {file}', '{count} component(s) from {file}', { file: l.fileName })}>{l.brand ? t('{name} (brand)', { name: l.name }) : l.name}</span>
          <button type="button" className="btn" data-testid="library-link" onClick={() => { void linkHere(l.id).then(later); }}>{t('Link')}</button>
        </div>
      ))}
      {kits.some((k) => !linkedNames.has(k.name)) ? <div className="asset-group-title" data-testid="kit-list">{t('Kits')}</div> : null}
      {kits.filter((k) => !linkedNames.has(k.name)).map((k) => (
        <div key={k.id} className="library-row" data-testid="kit-row" data-kit={k.id}>
          <span className="library-name" title={k.design ? t.n(k.components.length, '{description} {count} components. Code: {library} ({license}), design after {design} ({designLicense}).', '{description} {count} components. Code: {library} ({license}), design after {design} ({designLicense}).', { description: k.description, library: k.library.name, license: k.library.license, design: k.design.name, designLicense: k.design.license }) : t.n(k.components.length, '{description} {count} components. Code: {library} ({license}).', '{description} {count} components. Code: {library} ({license}).', { description: k.description, library: k.library.name, license: k.library.license })}>{k.platform !== 'web' ? t('{name} (phone)', { name: k.name }) : k.name}</span>
          <button type="button" className="btn" data-testid="kit-use" title={t('Link its components, and add its tokens with a dark mode.')} onClick={() => { void useKitHere(k).then(later); }}>{t('Use')}</button>
        </div>
      ))}
    </div>
  );
}
