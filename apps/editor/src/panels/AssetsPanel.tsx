import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getTextStyles, isLibraryParent, libraryLinks, nodeToHtml, RESET_CSS, textStylesCss, themeCss, type BogenNode } from '@bogen/core';
import { Component, Search } from 'lucide-react';
import { useSnapVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { resolveAsset } from '../lib/api.ts';
import { dropInstance, goToMain } from '../ops/components.ts';
import { Empty } from '../ui/controls.tsx';
import { LibraryControls } from './LibraryControls.tsx';
import { CodeAssets } from './CodeAssets.tsx';
import { useT } from '../i18n/react.ts';

/** What a preview needs to look like the canvas: nothing from the editor's own stylesheet gets in. */
function previewCss(): string {
  const { snap } = session();
  return [RESET_CSS, themeCss(snap.tokens, snap.modes, { selector: ':host' }), textStylesCss(getTextStyles(session().doc)), snap.keyframes].filter(Boolean).join('\n');
}

const Preview = memo(function Preview({ id, version, label }: { id: string; version: number; label: string }) {
  const t = useT();
  const host = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState('');
  useEffect(() => {
    // A main edit should not rebuild every preview on every keystroke.
    const timer = window.setTimeout(() => {
      const { doc } = session();
      setHtml(nodeToHtml(doc, id, { stripRootPosition: true, resolve: resolveAsset }));
    }, html ? 200 : 0);
    return () => clearTimeout(timer);
  }, [id, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>${previewCss()}</style><div class="fit" style="position:absolute;left:0;top:0;transform-origin:0 0;width:max-content">${html}</div>`;
    const box = shadow.querySelector<HTMLElement>('.fit')!;
    const w = box.scrollWidth || 1;
    const h = box.scrollHeight || 1;
    const scale = Math.min(1, (el.clientWidth - 8) / w, (el.clientHeight - 8) / h);
    box.style.transform = `translate(${(el.clientWidth - w * scale) / 2}px, ${(el.clientHeight - h * scale) / 2}px) scale(${scale})`;
  }, [html]);
  return <div ref={host} className="asset-preview" aria-label={t('Preview of {name}', { name: label })} role="img" />;
});

interface Entry { key: string; title: string; main: BogenNode; members: BogenNode[] }

function entriesOf(mains: BogenNode[]): Entry[] {
  const groups = new Map<string, Entry>();
  for (const main of mains) {
    // A set in a library is not the same set as one of that name here.
    const key = main.component?.set ? `${isLibraryParent(main.parent) ? main.parent : ''}/${main.component.set}` : main.id;
    const entry = groups.get(key);
    if (entry) entry.members.push(main);
    else groups.set(key, { key, title: main.component?.set ?? main.name, main, members: [main] });
  }
  return [...groups.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function variantLabel(member: BogenNode): string {
  return Object.values(member.component?.variant ?? {}).join(' ') || member.name;
}

/** Drags are pointer-driven, so a ghost follows and the canvas can tell where it ended. */
function useAssetDrag(onDrop: (mainId: string, x: number, y: number) => void) {
  const [ghost, setGhost] = useState<{ x: number; y: number; id: string; name: string } | null>(null);
  const start = (e: React.PointerEvent, id: string, name: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let active = false;
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      active = true;
      setGhost({ x: ev.clientX, y: ev.clientY, id, name });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setGhost(null);
      if (!active) return;
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      if (over?.closest('[data-testid="canvas"]') && !over.closest('[data-ui]')) onDrop(id, ev.clientX, ev.clientY);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { ghost, start };
}

export function AssetsPanel() {
  const t = useT();
  const version = useSnapVersion();
  const [query, setQuery] = useState('');
  const { snap } = session();
  const counts = useMemo(() => {
    const out = new Map<string, number>();
    for (const n of snap.nodes.values()) if (n.instanceOf !== undefined) out.set(n.instanceOf, (out.get(n.instanceOf) ?? 0) + 1);
    return out;
  }, [snap, version]);
  const mains = useMemo(() => [...snap.mains].flatMap((id) => snap.nodes.stored(id) ?? []), [snap, version]);
  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entriesOf(mains).filter((e) => !q || e.title.toLowerCase().includes(q) || e.members.some((m) => m.name.toLowerCase().includes(q) || (m.component?.description ?? '').toLowerCase().includes(q)));
  }, [mains, query]);
  const groups = useMemo(() => {
    const links = libraryLinks(session().doc);
    const out: { key: string; title: string; entries: Entry[] }[] = [{ key: '', title: '', entries: entries.filter((e) => !isLibraryParent(e.main.parent)) }];
    const byLib = new Map<string, Entry[]>();
    for (const e of entries) {
      if (!isLibraryParent(e.main.parent)) continue;
      const lib = e.main.parent.slice(4);
      byLib.set(lib, [...(byLib.get(lib) ?? []), e]);
    }
    for (const [lib, list] of byLib) out.push({ key: lib, title: links.find((l) => l.id === lib)?.name ?? t('Library'), entries: list });
    return out;
  }, [entries, version, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const { ghost, start } = useAssetDrag((id, x, y) => dropInstance(id, x, y));
  return (
    <div className="assets" data-testid="assets-panel">
      <div className="assets-head">
        <label className="field">
          <span className="field-label is-static"><Search size={14} /></span>
          <input className="field-input" placeholder={t('Search components')} value={query} data-testid="assets-search" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} spellCheck={false} />
        </label>
      </div>
      <div className="assets-scroll">
        {!mains.length ? <Empty title={t('No components yet')} hint={t('Select a layer and press {shortcut}. Agents make them with {tool}.', { shortcut: 'Ctrl+Alt+K', tool: 'component_create' })} /> : null}
        {mains.length > 0 && !entries.length ? <Empty title={t('Nothing here')} hint={t('No component matches this search.')} /> : null}
        {groups.map((group) => (group.entries.length ? (
          <div key={group.key || 'here'} className="asset-group" data-testid="asset-group" data-library={group.key || undefined}>
            {group.key ? <div className="asset-group-title" title={t('A shared library. Its components stay linked to it.')}>{group.title}</div> : null}
        {group.entries.map((entry) => (
          <div key={entry.key} className="asset" data-testid="asset" data-name={entry.title} data-main={entry.main.id}>
            <div className="asset-head" title={entry.main.component?.description}>
              <Component size={13} className="ds-mark" />
              <span className="asset-name" dir="auto">{entry.title}</span>
              <span className="asset-count">{entry.members.reduce((sum, m) => sum + (counts.get(m.id) ?? 0), 0) || ''}</span>
            </div>
            <div className={`asset-members${entry.members.length > 1 ? ' is-set' : ''}`}>
              {entry.members.map((member) => (
                <div
                  key={member.id}
                  className="asset-member"
                  data-testid="asset-member"
                  data-main={member.id}
                  title={t('Drag onto the canvas for an instance. Double click for the main.')}
                  onPointerDown={(e) => start(e, member.id, entry.title)}
                  onDoubleClick={() => goToMain(member.id)}
                >
                  <Preview id={member.id} version={version} label={member.name} />
                  {entry.members.length > 1 ? <span className="asset-variant">{variantLabel(member)}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ))}
          </div>
        ) : null))}
        <CodeAssets query={query} />
        <LibraryControls />
      </div>
      {ghost ? createPortal(<div className="asset-ghost" style={{ left: ghost.x + 8, top: ghost.y + 8 }} data-testid="asset-ghost"><Component size={13} /> {ghost.name}</div>, document.body) : null}
    </div>
  );
}
