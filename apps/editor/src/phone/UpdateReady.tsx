import { useSyncExternalStore } from 'react';
import { applyUpdate, onUpdateWaiting, updateWaiting } from '../lib/phone.ts';
import { useT } from '../i18n/react.ts';

/** A new build is installed and waits. It takes over when asked, so nothing reloads under someone's hands. */
export function UpdateReady() {
  const t = useT();
  const ready = useSyncExternalStore(onUpdateWaiting, updateWaiting);
  if (!ready) return null;
  return (
    <div className="update-ready" role="status" data-testid="update-ready">
      <span>{t('A new version of Bogen is ready.')}</span>
      <button type="button" onClick={applyUpdate}>{t('Reload')}</button>
    </div>
  );
}
