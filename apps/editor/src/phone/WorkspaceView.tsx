import { useT } from '../i18n/react.ts';
import { setPhoneWorkspaceView, usePhoneWorkspaceView, type PhoneWorkspaceView } from './workspace-view.ts';

export function WorkspaceView({ full, onChange }: { full?: boolean; onChange?: (view: PhoneWorkspaceView) => void }) {
  const t = useT(), view = usePhoneWorkspaceView();
  return <label className="phone-workspace-view"><span>{t('View')}</span><select value={full ? 'full' : view} aria-label={t('View')} data-testid="phone-workspace-view" onChange={event => {
    const next = event.target.value as PhoneWorkspaceView;
    if (onChange) onChange(next); else setPhoneWorkspaceView(next);
  }}><option value="touch">{t('Touch view')}</option><option value="full">{t('Full workspace')}</option></select></label>;
}
