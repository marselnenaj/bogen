import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { fontFacesCss, isModeName, observeFontFaces, RESET_CSS, textStylesCss, themeCss } from '@bogen/core';
import { useModes, usePages, useSnapVersion, useTextStyles, useTokens } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { resolveAsset } from '../lib/api.ts';
import { pasteImage } from '../ops/clipboard.ts';
import { dropLayerFile, isLayerFile } from '../ops/import-layers.ts';
import { camera } from '../state/camera.ts';
import { useEditor } from '../state/store.ts';
import { setWorldEl } from './measure.ts';
import { PageLayers } from './PageLayers.tsx';
import { Overlay } from './Overlay.tsx';
import { FindBar } from './FindBar.tsx';
import { TextRangeBar } from './TextRangeBar.tsx';
import { onDoubleClick, onPointerDown, onPointerLeave, onPointerMove, onPointerUp, onWheel } from './pointer.ts';
import { ContextMenu, openContextMenu } from './ContextMenu.tsx';
import { useT } from '../i18n/react.ts';
import { onTouchDown, onTouchMove, onTouchUp, touchRecent } from './touch.ts';

function scopeReset(css: string): string {
  return css.split('}').filter((r) => r.trim()).map((rule) => {
    const [sel = '', body = ''] = rule.split('{');
    const selectors = sel.split(',').map((x) => x.trim()).filter((x) => x && x !== 'body').map((x) => `.bogen-world ${x}`).join(',');
    return `${selectors}{${body}}`;
  }).join('');
}

const SCOPED_RESET = scopeReset(RESET_CSS);

export function WorldStyles() {
  const tokens = useTokens();
  const { snap } = session();
  useSnapVersion();
  const keyframes = snap.keyframes;
  const modes = useModes();
  const textStyles = useTextStyles();
  const css = useMemo(() => {
    const vars = themeCss(tokens, modes, { selector: '.bogen-world', modeSelector: (m) => `.bogen-world[data-mode="${m}"],.bogen-world [data-mode="${m}"]` });
    // Scoped so that a class beats the reset rule for buttons, as it does in an export.
    return [SCOPED_RESET, vars, textStylesCss(textStyles, '.bogen-world '), keyframes].filter(Boolean).join('\n');
  }, [tokens, modes, textStyles, keyframes]);
  return <style>{css}</style>;
}

/** Fonts the document carries. Outside the scoped world styles, as `@font-face` cannot be scoped. */
export function DocumentFonts() {
  const { doc } = session();
  const css = useSyncExternalStore((fn) => observeFontFaces(doc, fn), () => fontFacesCss(doc, resolveAsset));
  return css ? <style data-testid="document-fonts">{css}</style> : null;
}

export function Canvas() {
  const t = useT();
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const [previewRoot, setPreviewRoot] = useState<HTMLDivElement | null>(null);
  const pageId = useEditor((s) => s.pageId);
  const tool = useEditor((s) => s.tool);
  const editingText = useEditor((s) => s.editingTextId);
  const pages = usePages();
  const pageMode = pages.find((p) => p.id === pageId)?.mode;

  useEffect(() => {
    const vp = viewport.current!;
    camera.setViewport(vp);
    camera.attach(world.current, overlay.current);
    setWorldEl(world.current);

    const resize = new ResizeObserver(() => camera.measureViewport());
    resize.observe(vp);

    const onContext = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-ui]')) return;
      e.preventDefault();
      // A long press opens the menu itself; some browsers also send contextmenu for it.
      if (touchRecent()) return;
      openContextMenu(e.clientX, e.clientY);
    };
    // Touch has its own gestures. Mouse, pen and trackpad keep the pointer.ts paths unchanged.
    const onDown = (e: PointerEvent) => (e.pointerType === 'touch' ? onTouchDown(e) : onPointerDown(e));
    const onMove = (e: PointerEvent) => (e.pointerType === 'touch' ? onTouchMove(e) : onPointerMove(e));
    const onUp = (e: PointerEvent) => (e.pointerType === 'touch' ? onTouchUp(e) : onPointerUp(e));
    // Double taps are worked out from the taps, so a dblclick the browser makes from them is a repeat.
    const onDblClick = (e: MouseEvent) => {
      if (!touchRecent()) onDoubleClick(e);
    };
    // Safari's own pinch events: without this the page zooms under a two finger gesture. Only while
    // fingers are down, so a trackpad pinch in desktop Safari stays as it was.
    const onGesture = (e: Event) => {
      if (touchRecent()) e.preventDefault();
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) {
        e.preventDefault();
        vp.classList.add('is-dropping');
      }
    };
    const onDragLeave = () => vp.classList.remove('is-dropping');
    const onDrop = (e: DragEvent) => {
      vp.classList.remove('is-dropping');
      const all = [...(e.dataTransfer?.files ?? [])];
      // A PDF or an SVG comes in as editable layers; other pictures as images.
      const layers = all.filter(isLayerFile);
      const files = all.filter((f) => f.type.startsWith('image/') && !isLayerFile(f));
      if (!files.length && !layers.length) return;
      e.preventDefault();
      camera.measureViewport();
      const at = camera.worldAt(e.clientX, e.clientY);
      files.forEach((f, i) => void pasteImage(f, { x: at.x + i * 24, y: at.y + i * 24 }));
      layers.forEach((f, i) => void dropLayerFile(f, { x: at.x + (files.length + i) * 24, y: at.y + (files.length + i) * 24 }));
    };

    vp.addEventListener('pointerdown', onDown);
    vp.addEventListener('pointermove', onMove);
    vp.addEventListener('pointerup', onUp);
    vp.addEventListener('pointercancel', onUp);
    vp.addEventListener('pointerleave', onPointerLeave);
    vp.addEventListener('dblclick', onDblClick);
    vp.addEventListener('wheel', onWheel, { passive: false });
    vp.addEventListener('contextmenu', onContext);
    vp.addEventListener('gesturestart', onGesture);
    vp.addEventListener('gesturechange', onGesture);
    vp.addEventListener('dragover', onDragOver);
    vp.addEventListener('dragleave', onDragLeave);
    vp.addEventListener('drop', onDrop);
    return () => {
      resize.disconnect();
      vp.removeEventListener('pointerdown', onDown);
      vp.removeEventListener('pointermove', onMove);
      vp.removeEventListener('pointerup', onUp);
      vp.removeEventListener('pointercancel', onUp);
      vp.removeEventListener('pointerleave', onPointerLeave);
      vp.removeEventListener('dblclick', onDblClick);
      vp.removeEventListener('wheel', onWheel);
      vp.removeEventListener('contextmenu', onContext);
      vp.removeEventListener('gesturestart', onGesture);
      vp.removeEventListener('gesturechange', onGesture);
      vp.removeEventListener('dragover', onDragOver);
      vp.removeEventListener('dragleave', onDragLeave);
      vp.removeEventListener('drop', onDrop);
      camera.attach(null, null);
      camera.setViewport(null);
      setWorldEl(null);
    };
  }, []);

  return (
    <div ref={viewport} className={`canvas tool-${tool}`} data-testid="canvas" tabIndex={-1} role="application" aria-label={t('Canvas. F6 moves between the toolbar, layers, canvas and inspector.')}>
      <div ref={world} className="bogen-world" data-mode={pageMode && isModeName(pageMode) ? pageMode : undefined}>
        <WorldStyles />
        <DocumentFonts />
        {pageId ? <PageLayers key={pageId} pageId={pageId} previewRoot={previewRoot} /> : null}
      </div>
      <div className="capture" style={editingText ? { pointerEvents: 'none' } : undefined} />
      <Overlay rootRef={overlay} previewRef={setPreviewRoot} />
      <FindBar />
      <TextRangeBar />
      <ContextMenu />
    </div>
  );
}
