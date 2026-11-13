import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { docFromContent, fontFacesCss, keyframesCss, nodeToHtml, tokensCss } from '@bogen/core';
import { onWheel } from '../canvas/pointer.ts';
import { resolveAsset } from '../lib/api.ts';
import { camera } from '../state/camera.ts';
import { useEditor } from '../state/store.ts';
import { compareMode, rememberCompareMode, setStageView, showCompare, useStageView, type CompareMode, type CompareView, type StageView } from './history-state.ts';
import { Segmented } from '../ui/controls.tsx';
import { ReplayStage } from './ReplayStage.tsx';
import { useT } from '../i18n/react.ts';

/** The version on the canvas, under the same camera, without touching the live document. */
function Preview({ view }: { view: Extract<StageView, { kind: 'preview' }> }) {
  const t = useT();
  const current = useEditor((s) => s.pageId);
  const doc = useMemo(() => docFromContent(view.content), [view.content]);
  const pages = doc.getPages();
  const [chosen, setChosen] = useState<string | null>(null);
  const pageId = chosen && doc.pages.has(chosen) ? chosen : current && doc.pages.has(current) ? current : pages[0]?.id ?? '';
  const world = useRef<HTMLDivElement>(null);
  const shield = useRef<HTMLDivElement>(null);
  const html = useMemo(() => doc.getChildren(pageId).map((n) => nodeToHtml(doc, n.id, { resolve: resolveAsset })).join(''), [doc, pageId]);
  const css = useMemo(() => [fontFacesCss(doc, resolveAsset), tokensCss(doc, '.history-world'), keyframesCss(doc)].filter(Boolean).join('\n'), [doc]);

  useEffect(() => {
    const apply = () => {
      const { x, y, z } = camera.value;
      if (world.current) world.current.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    };
    apply();
    const off = camera.subscribe(apply);
    const el = shield.current!;
    // Pan and zoom still work. Clicks stop here, and do not reach the layers underneath.
    const wheel = (e: WheelEvent) => onWheel(e);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      off();
      el.removeEventListener('wheel', wheel);
    };
  }, []);

  return (
    <div className="history-stage" data-testid="history-stage">
      <div className="history-canvas" ref={shield} data-testid="history-preview-canvas">
        <style>{css}</style>
        <div ref={world} className="bogen-world history-world" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <div className="history-bar">
        <span className="history-bar-title">{t('Looking at: {label}', { label: view.label })}</span>
        {pages.length > 1 ? (
          <select className="history-page" value={pageId} onChange={(e) => setChosen(e.target.value)} aria-label={t('Page')} data-testid="history-preview-page">
            {pages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        ) : null}
        <button type="button" className="btn" onClick={() => setStageView(null)} data-testid="history-preview-exit">{t('Back to now')}</button>
      </div>
    </div>
  );
}

/** The four ways to look at two pictures. The choice is kept on this device. */
const MODES: CompareMode[] = ['side', 'overlay', 'swipe', 'diff'];

/** Two scroll panes that follow each other, by the share scrolled, so that pictures of different heights stay aligned. */
function useScrollTogether(on: boolean) {
  const panes = useRef<(HTMLDivElement | null)[]>([]);
  const busy = useRef(false);
  const follow = useCallback((from: number) => {
    if (!on || busy.current) return;
    const a = panes.current[from];
    const b = panes.current[from === 0 ? 1 : 0];
    if (!a || !b) return;
    busy.current = true;
    const ratio = (n: number, of: number) => (of > 0 ? n / of : 0);
    b.scrollTop = ratio(a.scrollTop, a.scrollHeight - a.clientHeight) * (b.scrollHeight - b.clientHeight);
    b.scrollLeft = ratio(a.scrollLeft, a.scrollWidth - a.clientWidth) * (b.scrollWidth - b.clientWidth);
    requestAnimationFrame(() => { busy.current = false; });
  }, [on]);
  return { panes, follow };
}

function Compare({ view }: { view: CompareView }) {
  const t = useT();
  const fileId = useEditor((s) => s.fileId);
  const [mode, setMode] = useState<CompareMode>(compareMode);
  const [together, setTogether] = useState(true);
  const [highlight, setHighlight] = useState(true);
  const [opacity, setOpacity] = useState(50);
  const [split, setSplit] = useState(50);
  const swipeBox = useRef<HTMLDivElement>(null);
  const { panes, follow } = useScrollTogether(together);
  const png = (b64: string | null | undefined) => (b64 ? `data:image/png;base64,${b64}` : null);
  const before = png(view.visual?.before);
  const after = png(view.visual?.after);
  const diff = png(view.visual?.diff);
  const choose = (next: CompareMode) => {
    setMode(next);
    rememberCompareMode(next);
  };
  const missing = view.visual ? t('Nothing on this page here') : view.error ?? t('Rendering');
  const picture = (src: string | null, label: string, testId: string) => (src
    ? <img src={src} alt={label} draggable={false} data-testid={testId} />
    : <div className="hint compare-missing">{missing}</div>);
  const index = view.screens?.findIndex((x) => x.id === view.screenId) ?? -1;
  const go = (step: number) => {
    const next = view.screens?.[index + step];
    if (!fileId || !next) return;
    void showCompare(fileId, { ...view, screenId: next.id, pageId: next.pageId, pageName: next.name });
  };
  const drag = (e: React.PointerEvent) => {
    const box = swipeBox.current?.getBoundingClientRect();
    if (!box || !(e.buttons & 1)) return;
    setSplit(Math.max(0, Math.min(100, ((e.clientX - box.left) / Math.max(1, box.width)) * 100)));
  };
  const both = Boolean(before && after);
  const label = (m: CompareMode) => (m === 'side' ? t('Side by side') : m === 'overlay' ? t('Overlay') : m === 'swipe' ? t('Swipe') : t('Difference'));
  return (
    <div className="history-stage history-compare" data-testid="history-stage" data-mode={mode}>
      <div className="compare-top" data-testid="compare-toolbar">
        <span className="compare-title" dir="auto">{t('{from} compared with {to}', { from: view.fromLabel, to: view.toLabel })}</span>
        <Segmented<CompareMode> value={mode} onChange={choose} testId="compare-mode" options={MODES.map((m) => ({ value: m, label: label(m), title: label(m) }))} />
        {mode === 'side' ? <label className="compare-opt"><input type="checkbox" checked={together} onChange={(e) => setTogether(e.target.checked)} data-testid="compare-scroll-together" />{t('Scroll together')}</label> : null}
        {mode === 'overlay' ? (
          <>
            <label className="compare-opt"><input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} data-testid="compare-highlight" />{t('Highlight differences')}</label>
            <label className="compare-opt">{t('Opacity')}<input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} data-testid="compare-opacity" /></label>
          </>
        ) : null}
      </div>
      {mode === 'side' ? (
        <div className="compare-side" data-testid="history-side">
          {([[view.fromLabel, before], [view.toLabel, after]] as const).map(([name, src], i) => (
            <figure key={i} className="compare-pane">
              <figcaption dir="auto">{name}</figcaption>
              <div className="compare-scroll" ref={(el) => { panes.current[i] = el; }} onScroll={() => follow(i)} data-testid={`compare-pane-${i}`}>{picture(src, name, 'history-side-image')}</div>
            </figure>
          ))}
        </div>
      ) : mode === 'overlay' ? (
        <div className="compare-single" data-testid="compare-overlay">
          {both ? (
            <div className="compare-stack">
              <img src={before!} alt={view.fromLabel} draggable={false} />
              <img src={after!} alt={view.toLabel} draggable={false} className="compare-over" style={{ opacity: opacity / 100 }} />
              {highlight && diff ? <img src={diff} alt={t('Difference')} draggable={false} className="compare-over compare-tint" data-testid="compare-tint" /> : null}
            </div>
          ) : picture(after ?? before, view.toLabel, 'compare-only')}
        </div>
      ) : mode === 'swipe' ? (
        <div className="compare-single" data-testid="compare-swipe">
          {both ? (
            <div className="compare-stack compare-swipe" ref={swipeBox} onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); drag(e); }} onPointerMove={drag}>
              <img src={before!} alt={view.fromLabel} draggable={false} />
              <img src={after!} alt={view.toLabel} draggable={false} className="compare-over" style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
              <div className="compare-handle" style={{ left: `${split}%` }} aria-hidden="true" />
              <span className="compare-tag is-left" dir="auto">{view.fromLabel}</span>
              <span className="compare-tag is-right" dir="auto">{view.toLabel}</span>
            </div>
          ) : picture(after ?? before, view.toLabel, 'compare-only')}
          {both ? <input className="compare-split" type="range" min={0} max={100} value={Math.round(split)} onChange={(e) => setSplit(Number(e.target.value))} onKeyDown={(e) => e.stopPropagation()} aria-label={t('Swipe')} data-testid="compare-split" /> : null}
        </div>
      ) : (
        <div className="compare-single" data-testid="compare-diff">{picture(diff, t('Difference'), 'compare-diff-image')}</div>
      )}
      <div className="history-bar">
        <span className="history-bar-title" data-testid="compare-percent">{view.visual?.percent != null ? t('{page}: {percent}% of the pixels differ', { page: view.pageName, percent: view.visual.percent }) : view.pageName}</span>
        {view.screens && view.screens.length > 1 ? (
          <>
            <button type="button" className="btn" disabled={index <= 0} onClick={() => go(-1)} data-testid="compare-prev">{t('Previous screen')}</button>
            <button type="button" className="btn" disabled={index < 0 || index >= view.screens.length - 1} onClick={() => go(1)} data-testid="compare-next">{t('Next screen')}</button>
          </>
        ) : null}
        <button type="button" className="btn" onClick={() => setStageView(null)} data-testid="history-preview-exit">{t('Back to now')}</button>
      </div>
    </div>
  );
}

export function HistoryStage() {
  const view = useStageView();
  if (!view) return null;
  if (view.kind === 'replay') return <ReplayStage key={`${view.fileId}/${view.pageId}`} fileId={view.fileId} pageId={view.pageId} />;
  return view.kind === 'preview' ? <Preview view={view} /> : <Compare view={view} />;
}
