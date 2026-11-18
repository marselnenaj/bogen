import { House, X } from 'lucide-react';
import { useCall } from '../call/call-session.ts';
import { useT } from '../i18n/react.ts';
import { Sheet } from '../phone/Sheet.tsx';
import { markText, TabMark, useTabHints } from './TabStrip.tsx';
import { closeTab, openHome, openTab, useTabs } from './tabs-state.ts';

/** On the phone, the open files in a sheet instead of a strip: switch to one, close one, or go Home. */
export function FileSwitcher({ onClose }: { onClose: () => void }) {
  const t = useT();
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.active);
  const marks = useTabs((s) => s.marks);
  const callFile = useCall((s) => (s.active ? s.fileId : null));
  const hintOf = useTabHints(tabs);
  return (
    <Sheet title={t('Open files')} onClose={onClose} testId="file-switcher">
      <div className="file-switcher">
        <div className="file-switcher-row">
          <button type="button" className="file-switcher-open" onClick={() => { onClose(); openHome(); }} data-testid="file-switcher-home">
            <span className="file-switcher-mark"><House size={16} aria-hidden="true" /></span>
            <span className="file-switcher-text"><span>{t('Home')}</span></span>
          </button>
        </div>
        {tabs.map((f) => {
          const on = f.id === active;
          const call = callFile === f.id;
          const hint = hintOf(f.id);
          const name = f.name || t('Untitled file');
          const said = markText(t, marks[f.id], call);
          return (
            <div key={f.id} className={`file-switcher-row${on ? ' is-on' : ''}`}>
              <button type="button" className="file-switcher-open" aria-current={on ? 'page' : undefined} onClick={() => { onClose(); openTab(f.id); }} data-testid="file-switcher-file" data-file={f.id}>
                <span className="file-switcher-mark"><TabMark marks={marks[f.id]} call={call} size={14} /></span>
                <span className="file-switcher-text">
                  <span dir="auto" translate="no">{name}{hint ? <span className="ftab-hint" data-testid="filetab-hint">{hint}</span> : null}</span>
                  {on || said ? <span className="file-switcher-sub">{on ? (said ? `${t('Open now')}. ${said}` : t('Open now')) : said}</span> : null}
                </span>
              </button>
              <button type="button" className="file-switcher-close" aria-label={t('Close {name}', { name: hint ? `${name} (${hint})` : name })} onClick={() => closeTab(f.id)} data-testid="file-switcher-close"><X size={16} strokeWidth={2.5} aria-hidden="true" /></button>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}
