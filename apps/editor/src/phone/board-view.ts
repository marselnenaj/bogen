import { fitRect, type Camera } from '../canvas/geometry.ts';
import { rectOf } from '../canvas/measure.ts';
import { maybeSession } from '../doc/session.ts';
import { camera } from '../state/camera.ts';
import { editor } from '../state/store.ts';
import { fitBoardCamera, orderBoards, phoneFile, type BoardBox, type SheetKind } from './file-state.ts';

/** The boards of a page, as the canvas lays them out: its artboards, or its top layers when it has none. */
export function measureBoards(pageId: string): BoardBox[] {
  const s = maybeSession();
  if (!s) return [];
  const nodes = s.snap.children(pageId).flatMap((id) => {
    const n = s.snap.nodes.get(id);
    return n && !n.hidden ? [n] : [];
  });
  const marked = nodes.filter((n) => n.artboard);
  const list = (marked.length ? marked : nodes).flatMap((n) => {
    const r = rectOf(n.id);
    return r && r.w > 0 && r.h > 0 ? [{ id: n.id, name: n.name, x: r.x, y: r.y, w: r.w, h: r.h }] : [];
  });
  return orderBoards(list);
}

/** How many boards a page has, without laying it out: for the list of pages. */
export function boardCount(pageId: string): number {
  const s = maybeSession();
  if (!s) return 0;
  const kids = s.snap.children(pageId).filter((id) => !s.snap.nodes.get(id)?.hidden);
  const boards = kids.filter((id) => s.snap.nodes.get(id)?.artboard).length;
  return boards || kids.length;
}

let frame = 0;
let pendingMove: { target: Camera; viewport: { width: number; height: number } } | null = null;

/** Moves the camera to `to` over a short moment. A new move or a finger on the canvas takes over. */
export function animateCamera(to: Camera, ms = 220): void {
  stopCameraAnimation();
  const from = { ...camera.value };
  if (matchMedia?.('(prefers-reduced-motion: reduce)').matches || ms <= 0) {
    camera.set(to, false);
    return;
  }
  pendingMove = { target: { ...to }, viewport: { width: camera.width, height: camera.height } };
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    const e = 1 - (1 - t) ** 3;
    camera.set({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e }, t < 1);
    if (t < 1) frame = requestAnimationFrame(step);
    else { pendingMove = null; frame = 0; }
  };
  frame = requestAnimationFrame(step);
}

export function stopCameraAnimation(): { target: Camera; viewport: { width: number; height: number } } | null {
  cancelAnimationFrame(frame);
  frame = 0;
  const move = pendingMove;
  pendingMove = null;
  return move;
}

function boardKey(fileId: string, pageId: string): string {
  return `bogen-phone-board-${fileId}-${pageId}`;
}

export function rememberedBoard(fileId: string, pageId: string): string | null {
  try { return localStorage.getItem(boardKey(fileId, pageId)); } catch { return null; }
}

/** Puts a board on the screen, as wide as it fits, and remembers it for this page. */
export function showBoard(id: string, animate = true): boolean {
  const r = rectOf(id);
  if (!r) return false;
  camera.measureViewport();
  const to = fitBoardCamera(r, camera.width, camera.height, 16);
  if (animate) animateCamera(to);
  else camera.set(to, false);
  phoneFile().set({ boardId: id });
  const { fileId, pageId } = editor();
  if (fileId && pageId) {
    try { localStorage.setItem(boardKey(fileId, pageId), id); } catch { /* fine */ }
  }
  return true;
}

/** Puts a layer on the screen, whole, with a little room around it. */
export function showLayer(id: string): void {
  const r = rectOf(id);
  if (!r) return;
  camera.measureViewport();
  animateCamera(fitRect(r, camera.width, camera.height, 24, 2));
}

/**
 * Opens a sheet, or closes the one open with null. Leaving the comment sheet puts the canvas back to
 * selecting, and drops a comment that was being placed.
 */
export function openSheet(next: SheetKind | null): void {
  const prev = phoneFile().sheet;
  if (prev === 'comment' && next !== 'comment') editor().set({ tool: 'move', pendingComment: null, activeThreadId: null });
  // A tap on the canvas places a comment now; a selection would only hide what it points at.
  if (next === 'comment' && prev !== 'comment') editor().set({ selection: [] });
  phoneFile().set({ sheet: next });
}
