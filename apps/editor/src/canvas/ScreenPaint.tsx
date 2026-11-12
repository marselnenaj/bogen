import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { BogenNode } from '@bogen/core';
import { worldRectOfClient } from './measure.ts';
import { onOverlayTick } from './overlay-tick.ts';
import type { Rect } from './geometry.ts';

/** A retained image outside the design DOM. Replacements are decoded before the current pixels change. */
export function ScreenPaint({ id, src, visible, element, node, target }: { id: string; src?: string; visible: boolean; element: HTMLElement | null; node?: BogenNode; target: HTMLElement | null }) {
  const [paint, setPaint] = useState<string>();
  const [box, setBox] = useState<(Rect & { radius: string }) | null>(null);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const image = new Image(); image.decoding = 'async'; image.src = src;
    void image.decode().then(() => { if (!cancelled) setPaint(src); }).catch(() => {});
    return () => { cancelled = true; image.src = ''; };
  }, [src]);
  useLayoutEffect(() => {
    if (!element || !target) return;
    const measure = () => {
      const r = worldRectOfClient(element.getBoundingClientRect());
      if (!r.w || !r.h) return;
      const next = { ...r, radius: getComputedStyle(element).borderRadius };
      setBox(old => old && ['x','y','w','h'].every(k => Math.abs(old[k as keyof Rect] - next[k as keyof Rect]) < .05) && old.radius === next.radius ? old : next);
    };
    const frame = requestAnimationFrame(measure), off = onOverlayTick(measure);
    const resize = new ResizeObserver(measure); resize.observe(element);
    return () => { cancelAnimationFrame(frame); off(); resize.disconnect(); };
  }, [element, target, node]);
  if (!target || !paint || !box) return null;
  return createPortal(<img data-ui="screen-preview" data-preview-for={id} data-bogen-preview={visible ? '' : undefined} aria-hidden="true" alt="" draggable={false} src={paint} decoding="async" style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, maxWidth: 'none', objectFit: 'fill', borderRadius: box.radius, pointerEvents: 'none', visibility: visible ? 'visible' : 'hidden' } as CSSProperties} />, target);
}

/** Keep the retained pixels through DOM mount and image/font decode; editing after that stays live. */
export function waitForScreenPaint(element: HTMLElement, done: () => void): () => void {
  let stopped = false, finishing = false, frame = 0;
  const preloads: HTMLImageElement[] = [];
  const timer = window.setTimeout(finish, 2500);
  function finish() {
    if (stopped || finishing) return;
    finishing = true;
    clearTimeout(timer);
    frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => { if (!stopped) done(); }); });
  }
  // Read after mount: CSS rules and asset styles from child effects have had a frame to attach.
  frame = requestAnimationFrame(() => {
    const view = element.closest('[data-testid="canvas"]')?.getBoundingClientRect();
    const assets: Promise<unknown>[] = [...element.querySelectorAll('img')].filter(image => {
      const r = image.getBoundingClientRect();
      return !view || (r.right >= view.left - 200 && r.left <= view.right + 200 && r.bottom >= view.top - 200 && r.top <= view.bottom + 200);
    }).map(image => image.decode().catch(() => {}));
    const background = getComputedStyle(element).backgroundImage;
    for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g)) {
      const image = new Image(); image.src = match[1]!; preloads.push(image); assets.push(image.decode().catch(() => {}));
    }
    assets.push(document.fonts.ready);
    void Promise.allSettled(assets).then(finish);
  });
  return () => { stopped = true; clearTimeout(timer); cancelAnimationFrame(frame); for (const image of preloads) image.src = ''; };
}
