import { MAX_ZOOM, MIN_ZOOM, type Camera, type Rect } from '../canvas/geometry.ts';
import { rectOf } from '../canvas/measure.ts';
import { maybeSession } from '../doc/session.ts';
import { camera } from '../state/camera.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { t } from '../i18n/store.ts';

/**
 * Fitting the screen you are working on to the window, without zooming by hand. Fit screen shows one artboard whole;
 * Fit width fills the canvas with its width, for a tall web page that would be unreadable whole. Both keep holding as
 * the window, the panels or the prompt change, until you pan or zoom yourself. The artboard is the selected one, the
 * one around the selection, or the one most in view: never every artboard of a large file.
 */

export type FitMode = 'screen' | 'width';

/** Room left around a fitted artboard, in screen pixels. */
export const FIT_MARGIN = 32;
/** A fitted artboard is never drawn larger than this: a small phone screen does not fill a 4K window. */
export const FIT_MAX_ZOOM = 2;

/** The part of the canvas a fit can use: the canvas less what lies over it (a drawer, the prompt at the bottom). */
export interface Area { x: number; y: number; w: number; h: number }

/** A camera that shows `rect` whole in `area`, centred, with a margin. */
export function fitScreenCamera(rect: Rect, area: Area, margin = FIT_MARGIN, maxZoom = FIT_MAX_ZOOM): Camera {
  const w = Math.max(1, area.w - margin * 2);
  const h = Math.max(1, area.h - margin * 2);
  const z = clampZoom(Math.min(maxZoom, w / Math.max(rect.w, 1), h / Math.max(rect.h, 1)));
  return { z, x: area.x + area.w / 2 - (rect.x + rect.w / 2) * z, y: area.y + area.h / 2 - (rect.y + rect.h / 2) * z };
}

/**
 * A camera that fills `area` with the width of `rect`, centred across. Down the page it keeps `top` (the world y at
 * the top of the canvas) inside the artboard, so refitting after a resize keeps your place on a long page; without it,
 * the artboard's top shows.
 */
export function fitWidthCamera(rect: Rect, area: Area, top?: number, margin = FIT_MARGIN, maxZoom = FIT_MAX_ZOOM): Camera {
  const z = clampZoom(Math.min(maxZoom, Math.max(1, area.w - margin * 2) / Math.max(rect.w, 1)));
  const x = area.x + area.w / 2 - (rect.x + rect.w / 2) * z;
  const maxTop = Math.max(rect.y, rect.y + rect.h - (area.h - margin) / z);
  const worldTop = top === undefined ? rect.y : Math.min(Math.max(top, rect.y), maxTop);
  const y = worldTop === rect.y ? area.y + margin - rect.y * z : area.y - worldTop * z;
  return { z, x, y };
}

/** The artboard that covers the most of the visible part of the canvas, then the one nearest its centre. */
export function boardInView(boards: { id: string; rect: Rect }[], view: Rect): string | null {
  let best: { id: string; area: number; dist: number } | null = null;
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  for (const b of boards) {
    const ix = Math.max(0, Math.min(view.x + view.w, b.rect.x + b.rect.w) - Math.max(view.x, b.rect.x));
    const iy = Math.max(0, Math.min(view.y + view.h, b.rect.y + b.rect.h) - Math.max(view.y, b.rect.y));
    const area = ix * iy;
    const dist = Math.hypot(b.rect.x + b.rect.w / 2 - cx, b.rect.y + b.rect.h / 2 - cy);
    if (!best || area > best.area || (area === best.area && dist < best.dist)) best = { id: b.id, area, dist };
  }
  return best?.id ?? null;
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

// ---------------------------------------------------------------- in the editor

/** The artboard Fit screen is about: the selected one, the one around the first selected layer, or the one most in view. */
export function fitTarget(): string | null {
  const s = maybeSession();
  const st = editor();
  if (!s || !st.pageId) return null;
  for (const id of st.selection) {
    const board = [id, ...s.doc.ancestors(id)].find((a) => s.snap.nodes.get(a)?.artboard && s.snap.pageOf(a) === st.pageId);
    if (board) return board;
  }
  const boards = s.snap.children(st.pageId).filter((id) => s.snap.nodes.get(id)?.artboard).flatMap((id) => {
    const rect = rectOf(id);
    return rect ? [{ id, rect }] : [];
  });
  return boardInView(boards, camera.visibleWorld());
}

/** The canvas less a drawer over it and the prompt when it sits at the bottom, in canvas pixels. */
export function fitArea(): Area {
  const stage = camera.viewport?.getBoundingClientRect();
  let area: Area = { x: 0, y: 0, w: camera.width, h: camera.height };
  if (!stage) return area;
  for (const el of document.querySelectorAll<HTMLElement>('.editor > .workspace > .panel-drawer:not([hidden])')) {
    const r = el.getBoundingClientRect();
    if (el.classList.contains('is-left')) area = { ...area, x: Math.max(area.x, r.right - stage.left), w: area.w - Math.max(0, r.right - stage.left - area.x) };
    else area = { ...area, w: Math.min(area.w, r.left - stage.left - area.x) };
  }
  const prompt = document.querySelector<HTMLElement>('main.stage > [data-testid="prompt"]');
  if (prompt) {
    const r = prompt.getBoundingClientRect();
    // Only a prompt docked at the bottom takes room; one floating next to a selection does not.
    if (r.bottom > stage.bottom - 48) area = { ...area, h: Math.max(120, Math.min(area.h, r.top - stage.top - area.y - 8)) };
  }
  return area;
}

let applying = false;

function apply(id: string, mode: FitMode, keepTop: boolean): boolean {
  const rect = rectOf(id);
  if (!rect || camera.width <= 0) return false;
  const area = fitArea();
  const top = keepTop ? camera.visibleWorld().y : undefined;
  const next = mode === 'screen' ? fitScreenCamera(rect, area) : fitWidthCamera(rect, area, top);
  applying = true;
  try {
    camera.set(next, false);
  } finally {
    applying = false;
  }
  return true;
}

/** Fits the target artboard, and keeps it fitted as the layout changes until you pan or zoom. */
export function fitScreen(mode: FitMode = 'screen'): void {
  const id = fitTarget();
  if (!id) {
    editor().showToast(t('There is no artboard on this page to fit.'));
    return;
  }
  if (apply(id, mode, false)) ui().set({ autoFit: { id, mode } });
}

/** Stops holding a fit, as panning or zooming by hand does. */
export function stopAutoFit(): void {
  if (ui().autoFit) ui().set({ autoFit: null });
}

/**
 * While a fit holds: refit on a change of the canvas size, a drawer or the prompt, at most once a frame, measuring only
 * the fitted artboard. Any other camera move (a pan, a zoom, following someone, going to a layer) lets go of it.
 */
export function startAutoFit(): () => void {
  let frame = 0;
  const refit = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const held = ui().autoFit;
      if (!held) return;
      camera.measureViewport();
      if (!apply(held.id, held.mode, held.mode === 'width')) ui().set({ autoFit: null });
    });
  };
  const offCamera = camera.subscribe(() => { if (!applying && ui().autoFit) ui().set({ autoFit: null }); });
  const offLayout = onLayoutChange(refit);
  const resize = new ResizeObserver(refit);
  if (camera.viewport) resize.observe(camera.viewport);
  window.addEventListener('resize', refit);
  return () => {
    cancelAnimationFrame(frame);
    offCamera();
    offLayout();
    resize.disconnect();
    window.removeEventListener('resize', refit);
  };
}

/** Refits when a drawer opens or closes or the prompt does: both change the room over the canvas. */
function onLayoutChange(fn: () => void): () => void {
  let drawer = ui().drawer;
  let prompt = editor().prompt.open;
  const offUi = useUi.subscribe((st) => { if (st.drawer !== drawer) { drawer = st.drawer; fn(); } });
  const offEditor = useEditor.subscribe((st) => { if (st.prompt.open !== prompt) { prompt = st.prompt.open; fn(); } });
  return () => { offUi(); offEditor(); };
}
