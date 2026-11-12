import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Link2, Maximize, RotateCcw, X } from 'lucide-react';
import type { ProtoTransition } from '@bogen/core';
import { DocumentFonts, WorldStyles } from '../canvas/Canvas.tsx';
import { NodeView } from '../canvas/NodeView.tsx';
import { Session, setSession } from '../doc/session.ts';
import { useSnapVersion } from '../doc/hooks.ts';
import { copyText, IconButton, NumberField, Segmented } from '../ui/controls.tsx';
import { interactionCss, neighbour, type ArtboardEntry } from './preview-model.ts';
import { usePrototype } from './prototype-run.ts';

const DEVICES: { value: string; label: string; title: string; width: number | null }[] = [
  { value: 'window', label: 'Window', title: 'Follow the browser window width', width: null },
  { value: 'real', label: 'Real', title: 'The size the artboard has', width: null },
  { value: '1440', label: '1440', title: 'Desktop, 1440 wide', width: 1440 },
  { value: '1280', label: '1280', title: 'Laptop, 1280 wide', width: 1280 },
  { value: '768', label: '768', title: 'Tablet, 768 wide', width: 768 },
  { value: '390', label: '390', title: 'Phone, 390 wide', width: 390 },
];

const hashFor = (fileId: string, artboard?: string) => `#/file/${fileId}/preview${artboard ? `/${artboard}` : ''}`;

function artboardsOf(s: Session): ArtboardEntry[] {
  const out: ArtboardEntry[] = [];
  for (const p of s.snap.pages) {
    const kids = s.snap.children(p.id).flatMap((id) => s.snap.nodes.get(id) ?? []);
    const boards = kids.filter((n) => n.artboard && !n.hidden);
    for (const n of boards.length ? boards : kids.filter((k) => k.type === 'frame' && !k.hidden)) {
      out.push({ id: n.id, name: n.name, pageId: p.id, pageName: p.name, width: parseFloat(n.style.width ?? '') || 0, height: parseFloat(n.style.height ?? '') || 0 });
    }
  }
  return out;
}

interface Shown { id: string; key: number }
interface Leaving extends Shown { transition: ProtoTransition; ms: number }

function PreviewBody({ session, fileId, initial }: { session: Session; fileId: string; initial?: string }) {
  const version = useSnapVersion();
  const boards = useMemo(() => artboardsOf(session), [session, version]);
  const [shown, setShown] = useState<Shown | null>(null);
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  const [enter, setEnter] = useState<{ transition: ProtoTransition; ms: number } | null>(null);
  const [device, setDevice] = useState('window');
  const [custom, setCustom] = useState<number | null>(null);
  const [present, setPresent] = useState(false);
  const counter = useRef(0);
  const timer = useRef(0);
  const reduced = useRef(matchMedia('(prefers-reduced-motion: reduce)').matches);

  const go = useCallback((id: string, transition: ProtoTransition = 'none', ms = 300) => {
    setShown((cur) => {
      if (cur?.id === id) return cur;
      const animated = transition !== 'none' && ms > 0 && !reduced.current;
      if (cur && animated) {
        setLeaving({ ...cur, transition, ms });
        setEnter({ transition, ms });
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => { setLeaving(null); setEnter(null); }, ms + 40);
      } else {
        setLeaving(null);
        setEnter(null);
      }
      return { id, key: ++counter.current };
    });
    history.replaceState(null, '', hashFor(fileId, id));
  }, [fileId]);

  useEffect(() => {
    if (!shown && boards.length) go(boards.find((b) => b.id === initial)?.id ?? boards[0]!.id);
  }, [boards, shown, initial, go]);
  const current = boards.find((b) => b.id === shown?.id);
  useEffect(() => {
    document.title = current ? `${current.name} - Preview - Bogen` : 'Preview - Bogen';
  }, [current]);
  const samePage = useMemo(() => boards.filter((b) => b.pageId === current?.pageId), [boards, current]);
  const nextId = current ? neighbour(samePage, current.id, 1) : null;
  const prevId = current ? neighbour(samePage, current.id, -1) : null;
  const width = custom ?? DEVICES.find((d) => d.value === device)?.width ?? null;

  const exitPresent = useCallback(() => {
    setPresent(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);
  const startPresent = useCallback(() => {
    setPresent(true);
    void document.documentElement.requestFullscreen?.().catch(() => {});
  }, []);
  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setPresent(false); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // Typing into a field of the design is typing, not moving between screens.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ' ') {
        if (e.key === ' ' || e.key === 'ArrowRight' || present) e.preventDefault();
        if (nextId && (e.key !== 'ArrowDown' || present)) go(nextId, 'fade', 200);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') {
        if (e.key === 'ArrowLeft' || present) e.preventDefault();
        if (prevId && (e.key !== 'ArrowUp' || present)) go(prevId, 'fade', 200);
      } else if (e.key === 'Home' && samePage[0]) go(samePage[0].id);
      else if (e.key === 'End' && samePage.at(-1)) go(samePage.at(-1)!.id);
      else if (e.key === 'Escape') {
        if (present) exitPresent();
        else location.hash = `#/file/${fileId}`;
      } else if (e.key === 'f' && !e.ctrlKey && !e.metaKey) {
        if (present) exitPresent();
        else startPresent();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [nextId, prevId, samePage, present, exitPresent, startPresent, go, fileId]);

  const run = usePrototype(session, version, shown?.id, go);
  const onClick = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (run.click(e.target)) {
      // The prototype answered: a link or a submit button does only that.
      if (el.closest('a,button')) e.preventDefault();
      return;
    }
    const anchor = el.closest('a');
    if (anchor) {
      // A link in the design goes where it says, without taking the preview along.
      e.preventDefault();
      if (anchor.href && !anchor.getAttribute('href')?.startsWith('#')) window.open(anchor.href, '_blank', 'noopener');
    }
  };

  const css = useMemo(() => interactionCss(session.snap.nodes.values()), [session, version]);
  const copyLink = () => void copyText(location.href);

  return (
    <div className={`pv${present ? ' is-present' : ''}`} data-testid="preview">
      {!present ? (
        <header className="pv-bar" data-testid="preview-bar">
          <a className="icon-btn" href={`#/file/${fileId}`} title="Back to the editor (Esc)" aria-label="Back to the editor" data-testid="preview-back"><ArrowLeft size={15} /></a>
          <IconButton icon={<ChevronLeft size={15} />} title="Previous artboard (←)" disabled={!prevId} onClick={() => prevId && go(prevId, 'fade', 200)} testId="preview-prev" />
          <select className="pv-select" aria-label="Artboard" value={shown?.id ?? ''} data-testid="preview-artboard" onChange={(e) => go(e.target.value)}>
            {boards.map((b) => <option key={b.id} value={b.id}>{b.pageName} / {b.name}</option>)}
          </select>
          <IconButton icon={<ChevronRight size={15} />} title="Next artboard (→)" disabled={!nextId} onClick={() => nextId && go(nextId, 'fade', 200)} testId="preview-next" />
          <span className="pv-spacer" />
          <div className="pv-devices"><Segmented<string> value={custom ? '' : device} onChange={(d) => { setDevice(d); setCustom(null); }} testId="preview-device" options={DEVICES.map((d) => ({ value: d.value, label: d.label, title: d.title }))} /></div>
          <div className="pv-custom"><NumberField label="W" value={custom} placeholder={String(current?.width ?? '')} min={100} max={6000} testId="preview-width" title="Any width" onChange={(v) => setCustom(v)} /></div>
          <span className="pv-spacer" />
          {run.stateful ? (
            <>
              <span className="pv-state" title={run.summary} data-testid="preview-state">{run.summary}</span>
              <IconButton icon={<RotateCcw size={15} />} title="Start the prototype again, from its first screen and its variables' starting values" onClick={run.restart} testId="preview-restart" />
            </>
          ) : null}
          <IconButton icon={<Link2 size={15} />} title="Copy the link to this preview" onClick={copyLink} testId="preview-copy" />
          <IconButton icon={<Maximize size={15} />} title="Present full screen (F)" onClick={startPresent} testId="preview-present" />
          <a className="icon-btn" href={`#/file/${fileId}`} title="Close preview (Esc)" aria-label="Close preview"><X size={15} /></a>
        </header>
      ) : null}
      <main
        className="pv-stage"
        data-testid="preview-stage"
        tabIndex={-1}
        onClick={onClick}
        onSubmit={(e) => { e.preventDefault(); run.submit(e.target); }}
        onChange={(e) => run.field(e.target)}
        onPointerOver={(e) => run.hover(e.target)}
        onPointerLeave={() => run.hover(null)}
      >
        <div className="bogen-world pv-world" style={width ? ({ '--pv-width': `${width}px` } as React.CSSProperties) : undefined} data-sized={width ? '' : undefined} data-fluid={!custom && device === 'window' ? '' : undefined}>
          <WorldStyles />
          <DocumentFonts />
          <style>{css}</style>
          {leaving ? <div key={`l${leaving.key}`} className={`pv-frame is-leaving pv-${leaving.transition}`} style={{ '--pv-ms': `${leaving.ms}ms` } as React.CSSProperties} aria-hidden="true"><NodeView id={leaving.id} /></div> : null}
          {shown ? <div key={shown.key} className={`pv-frame${enter ? ` is-entering pv-${enter.transition}` : ''}`} style={enter ? ({ '--pv-ms': `${enter.ms}ms` } as React.CSSProperties) : undefined} data-testid="preview-frame" data-artboard={shown.id}><NodeView id={shown.id} /></div> : null}
        </div>
        {!boards.length ? <div className="pv-empty">This file has nothing to preview yet.</div> : null}
      </main>
      {present ? <div className="pv-count" data-testid="preview-count">{samePage.findIndex((b) => b.id === current?.id) + 1} / {samePage.length}</div> : null}
    </div>
  );
}

/** An artboard at its real size in its own view: links between artboards, hover states, transitions. */
export function Preview({ fileId, artboardId }: { fileId: string; artboardId?: string }) {
  const [s, setS] = useState<Session | null>(null);
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    const session = new Session(fileId);
    // A viewer, not a collaborator: nobody sees a cursor or a selection from here, and nothing is written.
    session.provider.awareness.setLocalState(null);
    setSession(session);
    setS(session);
    const onSync = (ok: boolean) => { if (ok) setSynced(true); };
    session.provider.on('sync', onSync);
    return () => {
      session.provider.off('sync', onSync);
      setSession(null);
      session.destroy();
      document.title = 'Bogen';
    };
  }, [fileId]);
  if (!s || !synced) return <div className="loading" data-testid="loading"><span>Opening the preview</span></div>;
  return <PreviewBody session={s} fileId={fileId} {...(artboardId ? { initial: artboardId } : {})} />;
}
