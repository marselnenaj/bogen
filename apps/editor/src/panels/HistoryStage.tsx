import { useEffect, useMemo, useRef, useState } from 'react';
import { docFromContent, fontFacesCss, keyframesCss, nodeToHtml, tokensCss } from '@bogen/core';
import { onWheel } from '../canvas/pointer.ts';
import { resolveAsset } from '../lib/api.ts';
import { camera } from '../state/camera.ts';
import { useEditor } from '../state/store.ts';
import { setStageView, useStageView, type StageView } from './history-state.ts';
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

function Compare({ view }: { view: Extract<StageView, { kind: 'compare' }> }) {
  const t = useT();
  const png = (b64: string | null | undefined) => (b64 ? `data:image/png;base64,${b64}` : null);
  const pictures: [string, string | null][] = [
    [view.fromLabel, png(view.visual?.before)],
    [view.toLabel, png(view.visual?.after)],
    [t('Difference'), png(view.visual?.diff)],
  ];
  return (
    <div className="history-stage history-compare" data-testid="history-stage">
      <div className="history-side" data-testid="history-side">
        {pictures.map(([label, src]) => (
          <figure key={label} className="history-pic">
            <figcaption>{label}</figcaption>
            {src ? <img src={src} alt={label} data-testid="history-side-image" /> : <div className="hint">{view.visual ? t('Nothing on this page here') : view.error ?? t('Rendering')}</div>}
          </figure>
        ))}
      </div>
      <div className="history-bar">
        <span className="history-bar-title">{view.visual?.percent != null ? t('{page}: {percent}% of the pixels differ', { page: view.pageName, percent: view.visual.percent }) : view.pageName}</span>
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
