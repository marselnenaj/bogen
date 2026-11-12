import { useRef, useState } from 'react';
import { ChevronDown, History } from 'lucide-react';
import { usePages } from '../doc/hooks.ts';
import { editDate, locationName, useRecentEdits, visitEdit } from '../lib/recent-edits.ts';
import { useT } from '../i18n/react.ts';
import { openTab } from './ChromePanels.tsx';
import { Popover } from '../ui/controls.tsx';
import '../styles/recent-edits.css';

export function RecentChanges() {
  const t = useT(), edits = useRecentEdits(), pages = usePages();
  const [open, setOpen] = useState(false), anchor = useRef<HTMLButtonElement>(null);
  const latest = edits[0], location = latest?.locations.find(l => pages.some(p => p.id === l.pageId));
  const showHistory = () => { setOpen(false); openTab('right', { rightTab: 'history' }); };
  return <div className="recent-changes" data-testid="recent-changes">
    <button ref={anchor} type="button" className="recent-toggle" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" data-testid="recent-toggle"><History size={13} /><span>{t('Recent changes')}</span><ChevronDown size={12} /></button>
    {location ? <button type="button" className="recent-latest" onClick={() => visitEdit(location)} title={`${latest!.actor} · ${latest!.summary}`} data-testid="recent-latest">{locationName({ ...location, pageName: pages.find(p => p.id === location.pageId)?.name ?? location.pageName })}</button> : latest ? <span className="recent-latest">{latest.summary}</span> : null}
    {latest ? <time className="recent-time" dateTime={new Date(latest.at).toISOString()} title={t('Last edited {date}', { date: editDate(latest.at) })}>{editDate(latest.at)}</time> : null}
    {open ? <Popover anchor={anchor.current} side="below" width={420} className="recent-popover" onClose={() => setOpen(false)} focus>
      <section className="recent-list" role="dialog" aria-label={t('Recent changes')} data-testid="recent-list">
        <div className="recent-list-head"><strong>{t('Recent changes')}</strong><button type="button" className="btn btn-quiet" onClick={showHistory}>{t('History')}</button></div>
        {!edits.length ? <p className="hint">{t('no changes yet')}</p> : edits.slice(0, 12).map(edit => <article className="recent-entry" key={edit.id} data-testid="recent-entry">
          <p className="recent-summary" dir="auto">{edit.summary}</p><p className="recent-meta">{edit.actor} · {editDate(edit.at)}</p>
          <div className="recent-locations">{edit.locations.slice(0, 3).map(l => <button key={`${l.pageId}/${l.screenId ?? ''}`} type="button" className="recent-location" disabled={!pages.some(p => p.id === l.pageId)} onClick={() => { if (visitEdit(l)) setOpen(false); }} title={t('Go to {name}', { name: locationName(l) })} data-testid="recent-location" data-page-id={l.pageId}>{locationName({ ...l, pageName: pages.find(p => p.id === l.pageId)?.name ?? l.pageName })}</button>)}
          {edit.locationCount > 3 ? <button type="button" className="recent-location" onClick={showHistory}>{t.n(edit.locationCount - Math.min(3, edit.locations.length), 'and {count} more', 'and {count} more')}</button> : null}</div>
        </article>)}
      </section>
    </Popover> : null}
  </div>;
}
