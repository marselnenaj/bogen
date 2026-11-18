import { ChevronDown, MonitorSmartphone } from 'lucide-react';
import { useT } from '../i18n/react.ts';
import { setPhoneWorkspaceView, usePhoneWorkspaceView, type PhoneWorkspaceView } from './workspace-view.ts';

/**
 * Touch view or the full workspace, as the system's own list. `field` is the full-width choice of Settings, `icon`
 * the small square in a file's top bar (the list opens from it), and the default the labelled select of the full
 * workspace and the pages sheet.
 */
export function WorkspaceView({ full, onChange, variant }: { full?: boolean; onChange?: (view: PhoneWorkspaceView) => void; variant?: 'field' | 'icon' }) {
  const t = useT(), view = usePhoneWorkspaceView();
  const value = full ? 'full' : view;
  const select = <select value={value} aria-label={t('View')} title={variant === 'icon' ? (value === 'full' ? t('Full workspace') : t('Touch view')) : undefined} data-testid="phone-workspace-view" onChange={event => {
    const next = event.target.value as PhoneWorkspaceView;
    if (onChange) onChange(next); else setPhoneWorkspaceView(next);
  }}><option value="touch">{t('Touch view')}</option><option value="full">{t('Full workspace')}</option></select>;
  if (variant === 'field') return <label className="phone-select phone-workspace-field">{select}<ChevronDown size={18} strokeWidth={2.6} aria-hidden="true" /></label>;
  if (variant === 'icon') return <label className="pf-view"><MonitorSmartphone size={22} strokeWidth={2.2} aria-hidden="true" />{select}</label>;
  return <label className="phone-workspace-view"><span>{t('View')}</span>{select}</label>;
}
