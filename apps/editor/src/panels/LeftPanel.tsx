import { useRef, useState } from 'react';
import { Component, Database, Layers, Palette, Stamp, Plus, Trash2 } from 'lucide-react';
import { usePages } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { editor, useEditor } from '../state/store.ts';
import { IconButton } from '../ui/controls.tsx';
import { LayerTree } from './LayerTree.tsx';
import { TokensPanel } from './TokensPanel.tsx';
import { BrandFilePanel } from './BrandFilePanel.tsx';
import { AssetsPanel } from './AssetsPanel.tsx';
import { DataPanel } from './DataPanel.tsx';
import { useT } from '../i18n/react.ts';
import { editDate, recentByPage, useRecentEdits } from '../lib/recent-edits.ts';

function PageList() {
  const t = useT();
  const pages = usePages();
  const recent = recentByPage(useRecentEdits());
  const current = useEditor((s) => s.pageId);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const s = session();

  const add = () => {
    let id = '';
    s.tx(() => { id = s.doc.createPage(`Page ${pages.length + 1}`); });
    editor().set({ pageId: id, selection: [], hoverId: null });
    setRenaming(id);
  };
  const remove = (id: string) => {
    if (pages.length <= 1) return;
    const i = pages.findIndex((p) => p.id === id);
    s.tx(() => s.doc.deletePage(id));
    if (current === id) editor().set({ pageId: pages[i + 1]?.id ?? pages[i - 1]?.id ?? null, selection: [] });
  };

  const onRowDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || renaming === id) return;
    const startY = e.clientY;
    const el = e.currentTarget as HTMLElement;
    let active = false;
    let target: number | null = null;
    const rowHeight = el.offsetHeight;
    const move = (ev: PointerEvent) => {
      if (!active && Math.abs(ev.clientY - startY) < 4) return;
      if (!active) {
        active = true;
        el.setPointerCapture(e.pointerId);
        setDragging(id);
      }
      const top = listRef.current!.getBoundingClientRect().top;
      target = Math.max(0, Math.min(pages.length, Math.round((ev.clientY - top) / rowHeight)));
      setDropAt(target);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (active && target !== null) {
        const from = pages.findIndex((p) => p.id === id);
        const index = target > from ? target - 1 : target;
        if (index !== from) s.tx(() => s.doc.movePage(id, index));
      }
      setDragging(null);
      setDropAt(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="pages" data-testid="pages">
      <div className="panel-head">
        <span className="panel-title">{t('Pages')}</span>
        <IconButton icon={<Plus size={14} />} title={t('Add page')} onClick={add} testId="page-add" />
      </div>
      <div className="page-list" ref={listRef}>
        {pages.map((p, i) => (
          <div
            key={p.id}
            className={`page-row${p.id === current ? ' is-active' : ''}${dragging === p.id ? ' is-dragging' : ''}${dropAt === i ? ' drop-before' : ''}${dropAt === i + 1 && i === pages.length - 1 ? ' drop-after' : ''}`}
            onPointerDown={(e) => onRowDown(e, p.id)}
            onClick={() => { if (p.id !== current) editor().set({ pageId: p.id, selection: [], hoverId: null }); }}
            onDoubleClick={() => setRenaming(p.id)}
            data-testid="page-row"
            data-page-id={p.id}
          >
            {renaming === p.id ? (
              <input
                autoFocus
                className="rename-input"
                defaultValue={p.name}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if (v && v !== p.name) s.tx(() => s.doc.renamePage(p.id, v));
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') { e.currentTarget.value = p.name; e.currentTarget.blur(); }
                }}
              />
            ) : <span className="page-name" dir="auto">{p.name}</span>}
            {recent.has(p.id) && renaming !== p.id ? <time className="page-edit-time" title={`${t('Last edited {date}', { date: editDate(recent.get(p.id)!.at) })} · ${recent.get(p.id)!.actor} · ${recent.get(p.id)!.summary}`} dateTime={new Date(recent.get(p.id)!.at).toISOString()} data-testid="page-last-edit">{editDate(recent.get(p.id)!.at)}</time> : null}
            {pages.length > 1 && renaming !== p.id ? (
              <IconButton className="row-action" icon={<Trash2 size={13} />} title={t('Delete {name}', { name: p.name })} onClick={(e) => { e.stopPropagation(); remove(p.id); }} tabIndex={-1} />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function LeftPanel() {
  const t = useT();
  const tab = useEditor((s) => s.leftTab);
  return (
    <aside className="panel panel-left" aria-label={t('Layers and pages')} data-testid="left-panel">
      <div className="tabs" role="tablist" aria-label={t('Left panel')}>
        <button type="button" role="tab" aria-selected={tab === 'layers'} title={t('Layers ({shortcut})', { shortcut: 'Alt+1' })} className={`tab${tab === 'layers' ? ' is-active' : ''}`} onClick={() => editor().set({ leftTab: 'layers' })} data-testid="tab-layers"><Layers size={14} /> {t('Layers')}</button>
        <button type="button" role="tab" aria-selected={tab === 'tokens'} title={t('Tokens ({shortcut})', { shortcut: 'Alt+2' })} className={`tab${tab === 'tokens' ? ' is-active' : ''}`} onClick={() => editor().set({ leftTab: 'tokens' })} data-testid="tab-tokens"><Palette size={14} /> {t('Tokens')}</button>
        <button type="button" role="tab" aria-selected={tab === 'assets'} title={t('Assets ({shortcut})', { shortcut: 'Alt+3' })} className={`tab${tab === 'assets' ? ' is-active' : ''}`} onClick={() => editor().set({ leftTab: 'assets' })} data-testid="tab-assets"><Component size={14} /> {t('Assets')}</button>
        <button type="button" role="tab" aria-selected={tab === 'data'} title={t('Data ({shortcut})', { shortcut: 'Alt+4' })} aria-label={t('Data')} className={`tab${tab === 'data' ? ' is-active' : ''}`} onClick={() => editor().set({ leftTab: 'data' })} data-testid="tab-data"><Database size={14} /></button>
        <button type="button" role="tab" aria-selected={tab === 'brand'} title={t('Brand')} className={`tab${tab === 'brand' ? ' is-active' : ''}`} onClick={() => editor().set({ leftTab: 'brand' })} data-testid="tab-brand"><Stamp size={14} /> {t('Brand')}</button>
      </div>
      {tab === 'layers' ? (
        <>
          <PageList />
          <LayerTree />
        </>
      ) : tab === 'brand' ? <BrandFilePanel /> : tab === 'assets' ? <AssetsPanel /> : tab === 'data' ? <DataPanel /> : <TokensPanel />}
    </aside>
  );
}
