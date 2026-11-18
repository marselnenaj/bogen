import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronDown, CloudOff, House, LoaderCircle, Phone, X } from 'lucide-react';
import { useCall } from '../call/call-session.ts';
import { useT } from '../i18n/react.ts';
import type { Translate } from '../i18n/core.ts';
import { closeTab, moveTab, openHome, openTab, useTabs, type FileTab, type TabMarks } from './tabs-state.ts';
import { hintText, tabHints } from './tab-names.ts';

/**
 * The open files of this window, above the toolbar: Home, then a tab per file, each with a mark for what happens in
 * it (an agent at work, the call, no connection, someone else). Designed in Bogen: "Bogen Brand System", page "Tabs".
 */

export const TABPANEL_ID = 'bogen-tabpanel';
export const tabDomId = (id: string | null) => (id ? `bogen-tab-${id}` : 'bogen-tab-home');

/** What a tab's mark says, for its tooltip and for screen readers. */
export function markText(t: Translate, marks: TabMarks | undefined, call: boolean): string {
  const out: string[] = [];
  if (call) out.push(t('The call is in this file'));
  if (marks?.working) out.push(t('{agent} is working here', { agent: marks.working }));
  if (marks?.offline) out.push(marks.pending ? t('Not connected, edits wait to sync') : t('Not connected'));
  else if (marks?.pending) out.push(t('Edits wait to sync'));
  if (marks?.peer) out.push(t('{name} has it open too', { name: marks.peer.name }));
  return out.join('. ');
}

/** The words that tell each open file from another of the same name, by file id ('' when its name is its own). */
export function useTabHints(tabs: readonly FileTab[]): (id: string) => string {
  const t = useT();
  const untitled = t('Untitled file');
  const keptCopy = t('kept copy');
  const hints = useMemo(() => tabHints(tabs, untitled), [tabs, untitled]);
  return (id: string) => hintText(hints.get(id), keptCopy);
}

/** A tab's name and, when another open file has the same name, what tells them apart. */
export function TabName({ name, hint }: { name: string; hint: string }) {
  return (
    <>
      <span className="ftab-name" dir="auto" translate="no">{name}</span>
      {hint ? <span className="ftab-hint" dir="auto" translate="no" data-testid="filetab-hint">{hint}</span> : null}
    </>
  );
}

/** The one mark a tab shows, by what matters most: the call, an agent, no connection, unsynced edits, someone else. */
export function TabMark({ marks, call, size = 12 }: { marks: TabMarks | undefined; call: boolean; size?: number }) {
  if (call) return <Phone className="ftab-mark is-call" size={size} fill="currentColor" strokeWidth={0} aria-hidden="true" data-mark="call" />;
  if (marks?.working) return <LoaderCircle className="ftab-mark is-agent is-turning" size={size} strokeWidth={3} aria-hidden="true" data-mark="working" />;
  if (marks?.offline) return <CloudOff className="ftab-mark" size={size} strokeWidth={2.2} aria-hidden="true" data-mark="offline" />;
  if (marks?.pending) return <span className="ftab-dot" aria-hidden="true" data-mark="pending" />;
  if (marks?.peer) return <span className="ftab-peer" aria-hidden="true" data-mark="peer">{marks.peer.letter}</span>;
  return null;
}

export function TabStrip() {
  const t = useT();
  const tabs = useTabs((s) => s.tabs);
  const active = useTabs((s) => s.active);
  const marks = useTabs((s) => s.marks);
  const callFile = useCall((s) => (s.active ? s.fileId : null));
  const hintOf = useTabHints(tabs);
  const list = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [menu, setMenu] = useState(false);
  const [drop, setDrop] = useState<number | null>(null);
  const dragging = useRef<string | null>(null);

  // More tabs than fit: the strip scrolls, and All tabs lists them.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = () => {
      setOverflow(el.scrollWidth > el.clientWidth + 1);
      document.getElementById(tabDomId(useTabs.getState().active))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tabs.length]);
  // The open tab stays in view.
  useEffect(() => {
    document.getElementById(tabDomId(active))?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, tabs.length]);

  const ids: (string | null)[] = [null, ...tabs.map((x) => x.id)];
  const focusAt = (i: number) => document.getElementById(tabDomId(ids[(i + ids.length) % ids.length]!))?.focus();
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).dataset.tab;
    if (id === undefined) return;
    const at = ids.indexOf(id || null);
    if (e.key === 'ArrowRight') focusAt(at + 1);
    else if (e.key === 'ArrowLeft') focusAt(at - 1);
    else if (e.key === 'Home') focusAt(0);
    else if (e.key === 'End') focusAt(ids.length - 1);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && id) {
      closeTab(id);
      focusAt(Math.min(at, ids.length - 2));
    } else return;
    e.preventDefault();
  };

  const tab = (f: FileTab, i: number) => {
    const on = f.id === active;
    const call = callFile === f.id;
    const m = marks[f.id];
    const hint = hintOf(f.id);
    const name = f.name || t('Untitled file');
    const label = hint ? `${name} (${hint})` : name;
    const said = markText(t, m, call);
    return (
      <div key={f.id} className={`ftab-wrap${drop === i ? ' is-drop-before' : ''}${drop === i + 1 && i === tabs.length - 1 ? ' is-drop-after' : ''}`}
        onDragOver={(e) => {
          if (!dragging.current) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          setDrop(e.clientX < r.left + r.width / 2 ? i : i + 1);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const id = dragging.current;
          if (id && drop !== null) {
            const from = tabs.findIndex((x) => x.id === id);
            moveTab(id, drop > from ? drop - 1 : drop);
          }
          dragging.current = null;
          setDrop(null);
        }}>
        <button type="button" role="tab" id={tabDomId(f.id)} data-tab={f.id} data-testid="filetab" data-file={f.id}
          className={`ftab${on ? ' is-on' : ''}`} aria-selected={on} aria-controls={on ? TABPANEL_ID : undefined} tabIndex={on ? 0 : -1}
          title={said ? `${label}. ${said}` : label} draggable
          onClick={() => openTab(f.id)}
          onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
          onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(f.id); } }}
          onDragStart={(e) => { dragging.current = f.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', name); }}
          onDragEnd={() => { dragging.current = null; setDrop(null); }}>
          <TabMark marks={m} call={call} />
          <TabName name={name} hint={hint} />
          {said ? <span className="visually-hidden">{`, ${said}`}</span> : null}
        </button>
        <button type="button" className="ftab-close" tabIndex={-1} aria-hidden="true" title={t('Close {name}', { name: label })}
          onClick={() => closeTab(f.id)} data-testid="filetab-close"><X size={12} strokeWidth={2.5} /></button>
      </div>
    );
  };

  return (
    <div className={`tabstrip${overflow ? ' is-overflowing' : ''}`} data-testid="tabstrip">
      <div ref={list} className="tabstrip-list" role="tablist" aria-label={t('Open files')} onKeyDown={onKey}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(null); }}>
        <div className="ftab-wrap is-home">
          <button type="button" role="tab" id={tabDomId(null)} data-tab="" data-testid="filetab-home" className={`ftab ftab-home${active === null ? ' is-on' : ''}`}
            aria-selected={active === null} aria-controls={active === null ? TABPANEL_ID : undefined} tabIndex={active === null ? 0 : -1}
            aria-label={t('Home')} title={t('Home')} onClick={openHome}>
            <House size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {tabs.map(tab)}
      </div>
      {overflow ? (
        <div className="tabstrip-more">
          <button type="button" className="tabstrip-all" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} data-testid="tabs-all">
            {t('All tabs {count}', { count: tabs.length })}<ChevronDown size={12} strokeWidth={2.5} aria-hidden="true" />
          </button>
          {menu ? <AllTabs tabs={tabs} active={active} marks={marks} callFile={callFile} onClose={() => setMenu(false)} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function AllTabs({ tabs, active, marks, callFile, onClose }: { tabs: FileTab[]; active: string | null; marks: Record<string, TabMarks>; callFile: string | null; onClose: () => void }) {
  const t = useT();
  const hintOf = useTabHints(tabs);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[aria-current="true"]') ?? ref.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
    const away = (e: PointerEvent) => { if (!ref.current?.parentElement?.contains(e.target as Node)) onClose(); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [onClose]);
  const items = () => [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
  const onKey = (e: ReactKeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { onClose(); (document.querySelector('[data-testid="tabs-all"]') as HTMLElement | null)?.focus(); }
    else if (e.key === 'ArrowDown') all[(at + 1) % all.length]?.focus();
    else if (e.key === 'ArrowUp') all[(at - 1 + all.length) % all.length]?.focus();
    else return;
    e.preventDefault();
  };
  return (
    <div ref={ref} className="tabs-menu" role="menu" aria-label={t('All tabs')} onKeyDown={onKey} data-testid="tabs-menu">
      {tabs.map((f) => {
        const call = callFile === f.id;
        const name = f.name || t('Untitled file');
        const hint = hintOf(f.id);
        const label = hint ? `${name} (${hint})` : name;
        const said = markText(t, marks[f.id], call);
        return (
          <button key={f.id} type="button" role="menuitem" className="tabs-menu-item" aria-current={f.id === active ? 'true' : undefined} tabIndex={-1}
            title={said ? `${label}. ${said}` : label} onClick={() => { onClose(); openTab(f.id); }}>
            <span className="tabs-menu-mark"><TabMark marks={marks[f.id]} call={call} /></span>
            <TabName name={name} hint={hint} />
            {said ? <span className="visually-hidden">{`, ${said}`}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
