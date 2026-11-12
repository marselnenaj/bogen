import { camera } from '../state/camera.ts';
import { maybeSession } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { openContextMenu } from './ContextMenu.tsx';
import { MAX_ZOOM, MIN_ZOOM, pointInRect, screenToWorld, unionRects, type Camera, type Vec } from './geometry.ts';
import { rectOf } from './measure.ts';
import { cancelDrag, hitAt, onDoubleClick, onPointerDown, onPointerMove, onPointerUp, resolveTarget } from './pointer.ts';
import { editingEl, stopTextEdit } from './text-edit.ts';

/**
 * Touch on the canvas. Mouse, pen and trackpad never come through here: Canvas sends only
 * `pointerType === 'touch'` events, and everything a finger does on the canvas is turned into the
 * same pointer.ts calls a mouse makes, or into camera moves.
 *
 * One finger:
 * - A tap selects, as a click does. The press is held back until the finger lifts or moves past the
 *   slop, so a shaky tap never turns into a tiny move and a pinch never starts a drag.
 * - A drag that starts on the selection (a selected layer, its handles, a frame label) edits it as a
 *   mouse drag would. With the move tool, any other drag pans: on a phone that is what a drag on the
 *   canvas most often means, and a marquee is rare. With the comment tool a drag pans too, and a tap
 *   places the comment. Other tools draw as they do with a mouse.
 * - A double tap does what a double click does. A long press opens the context menu.
 * Two fingers pinch zoom around their midpoint and pan at the same time. A finger landing during a
 * one finger drag cancels that drag first.
 */

export const TOUCH_SLOP = 8;
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_DIST = 24;
export const LONG_PRESS_MS = 500;

export interface TouchSample { t: number; x: number; y: number }

export function distance(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** What a one finger press is: `travel` is the furthest it got from where it landed. */
export function classifyPress(duration: number, travel: number): 'tap' | 'long-press' | 'drag' {
  if (travel > TOUCH_SLOP) return 'drag';
  return duration >= LONG_PRESS_MS ? 'long-press' : 'tap';
}

/** Whether a press landing at `next` makes a double tap with the tap that ended at `prev`. */
export function isDoubleTap(prev: TouchSample | null, next: TouchSample): boolean {
  if (!prev) return false;
  const dt = next.t - prev.t;
  return dt >= 0 && dt <= DOUBLE_TAP_MS && distance(prev, next) <= DOUBLE_TAP_DIST;
}

/**
 * The camera after two fingers moved from `a0`, `b0` to `a1`, `b1` (viewport coordinates). Zoom follows
 * the spread of the fingers within the wheel zoom limits, and the world point that was under the first
 * midpoint stays under the current one, which pans as the fingers move together. Worked out from the
 * start of the gesture each time, so it does not drift.
 */
export function pinchCamera(start: Camera, a0: Vec, b0: Vec, a1: Vec, b1: Vec): Camera {
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, start.z * (distance(a1, b1) / Math.max(1, distance(a0, b0)))));
  const anchor = screenToWorld(start, { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2 });
  const mid = { x: (a1.x + b1.x) / 2, y: (a1.y + b1.y) / 2 };
  return { z, x: mid.x - anchor.x * z, y: mid.y - anchor.y * z };
}

// What one finger moves

/**
 * `view` moves the canvas whatever the finger lands on, so looking around never shifts a layer by
 * accident. `move` drags any layer it lands on, selected or not, and pans only off the layers. Two
 * fingers always pan and zoom. Remembered per device, since it is about the hand, not the file.
 */
export type DragMode = 'view' | 'move';
const DRAG_KEY = 'bogen.touchDrag';
let dragMode: DragMode = (() => {
  try { return localStorage.getItem(DRAG_KEY) === 'move' ? 'move' : 'view'; } catch { return 'view'; }
})();
const dragListeners = new Set<() => void>();
export const getDragMode = (): DragMode => dragMode;
export function setDragMode(next: DragMode): void {
  if (next === dragMode) return;
  dragMode = next;
  try { localStorage.setItem(DRAG_KEY, next); } catch { /* private mode: it lasts this visit */ }
  dragListeners.forEach((fn) => fn());
}
export function onDragMode(fn: () => void): () => void {
  dragListeners.add(fn);
  return () => dragListeners.delete(fn);
}

// The running gesture

type Mode = 'idle' | 'pending' | 'pan' | 'forward' | 'held' | 'pinch';

interface Press { id: number; down: PointerEvent; t: number; x: number; y: number; travel: number }

const fingers = new Map<number, Vec>();
let mode: Mode = 'idle';
let press: Press | null = null;
let pressTimer = 0;
let panFrom: Vec = { x: 0, y: 0 };
let pinch: { cam: Camera; a: number; b: number; a0: Vec; b0: Vec } | null = null;
let lastTap: TouchSample | null = null;
let lastTouchEnd = -Infinity;

/** A finger is down, or just lifted: the browser's own dblclick and contextmenu belong to us then. */
export function touchRecent(): boolean {
  return fingers.size > 0 || performance.now() - lastTouchEnd < 800;
}

export function onTouchDown(e: PointerEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest('[data-ui]')) return;
  // Inside the text being edited the browser places the caret and selects.
  const editing = editingEl();
  if (editing && (target === editing || editing.contains(target))) return;
  if (fingers.size >= 2) return;
  e.preventDefault();
  camera.measureViewport();
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { camera.viewport?.setPointerCapture?.(e.pointerId); } catch { /* already gone */ }

  if (fingers.size === 1) {
    press = { id: e.pointerId, down: e, t: performance.now(), x: e.clientX, y: e.clientY, travel: 0 };
    mode = 'pending';
    clearTimeout(pressTimer);
    pressTimer = window.setTimeout(longPress, LONG_PRESS_MS);
    return;
  }
  // A second finger: whatever the first one started gives way to the pinch.
  clearTimeout(pressTimer);
  lastTap = null;
  if (mode === 'forward') cancelDrag();
  const [[a, pa], [b, pb]] = [...fingers] as [[number, Vec], [number, Vec]];
  pinch = { cam: { ...camera.value }, a, b, a0: camera.fromClient(pa.x, pa.y), b0: camera.fromClient(pb.x, pb.y) };
  mode = 'pinch';
}

export function onTouchMove(e: PointerEvent): void {
  if (!fingers.has(e.pointerId)) return;
  const at = { x: e.clientX, y: e.clientY };
  fingers.set(e.pointerId, at);
  switch (mode) {
    case 'pending': {
      if (!press) return;
      press.travel = Math.max(press.travel, distance(press, at));
      if (classifyPress(performance.now() - press.t, press.travel) !== 'drag') return;
      clearTimeout(pressTimer);
      lastTap = null;
      if (pansHere(press.down)) {
        mode = 'pan';
        panFrom = { x: press.x, y: press.y };
        panTo(at);
      } else {
        mode = 'forward';
        onPointerDown(press.down);
        onPointerMove(e);
      }
      return;
    }
    case 'pan': return panTo(at);
    case 'forward': return onPointerMove(e);
    case 'pinch': {
      if (!pinch) return;
      const a = fingers.get(pinch.a);
      const b = fingers.get(pinch.b);
      if (!a || !b) return;
      camera.set(pinchCamera(pinch.cam, pinch.a0, pinch.b0, camera.fromClient(a.x, a.y), camera.fromClient(b.x, b.y)));
      return;
    }
    default: return undefined;
  }
}

export function onTouchUp(e: PointerEvent): void {
  if (!fingers.delete(e.pointerId)) return;
  try { camera.viewport?.releasePointerCapture?.(e.pointerId); } catch { /* already gone */ }
  lastTouchEnd = performance.now();
  const cancelled = e.type === 'pointercancel';
  if (mode === 'pending') {
    clearTimeout(pressTimer);
    if (!cancelled && press) tap(press, e);
  } else if (mode === 'forward') {
    onPointerUp(e);
  } else if (mode === 'held') {
    swallowClick({ x: e.clientX, y: e.clientY });
  } else if (mode === 'pinch' && fingers.size === 1) {
    // The finger still down carries on panning, as in a map.
    pinch = null;
    mode = 'pan';
    panFrom = [...fingers.values()][0]!;
    return;
  }
  if (fingers.size === 0) reset();
}

function reset(): void {
  clearTimeout(pressTimer);
  mode = 'idle';
  press = null;
  pinch = null;
}

function panTo(at: Vec): void {
  camera.pan(at.x - panFrom.x, at.y - panFrom.y);
  panFrom = at;
}

/** Whether a one finger drag from here pans rather than edits. */
function pansHere(down: PointerEvent): boolean {
  const state = editor();
  // With the comment tool a tap places the comment, so a drag can look around as with the move tool.
  if ((state.tool !== 'move' && state.tool !== 'comment') || state.editingPathId) return false;
  if (dragMode === 'view') return true;
  const target = down.target as HTMLElement;
  if (target.closest('[data-handle],[data-rotate],[data-gap],[data-padding],[data-gradient],[data-frame-label],[data-pin]')) return false;
  const hit = hitAt(down.clientX, down.clientY);
  // Move mode: a layer under the finger is what it drags, as a mouse would pick it up. Not the board
  // itself, which fills a phone's screen: dragging that would carry the whole screen off.
  if (hit) {
    const target = resolveTarget(hit, false);
    const board = maybeSession()?.snap.nodes.get(target)?.parent === state.pageId;
    if (!board || state.selection.includes(target)) return false;
  }
  if (hit && state.selection.includes(resolveTarget(hit, false))) return false;
  if (state.selection.length > 1) {
    const u = unionRects(state.selection.flatMap((id) => rectOf(id) ?? []));
    if (u && pointInRect(camera.worldAt(down.clientX, down.clientY), u)) return false;
  }
  return true;
}

function tap(p: Press, up: PointerEvent): void {
  const now = performance.now();
  const double = isDoubleTap(lastTap, { t: p.t, x: p.x, y: p.y });
  try {
    onPointerDown(p.down);
  } catch {
    // Some browsers have let go of a lifted finger already, and pointer capture throws. The press still counts.
  }
  onPointerUp(up);
  if (double) {
    lastTap = null;
    onDoubleClick(up);
  } else {
    lastTap = { t: now, x: p.x, y: p.y };
  }
}

function longPress(): void {
  if (mode !== 'pending' || !press) return;
  mode = 'held';
  lastTap = null;
  if (editingEl()) stopTextEdit();
  openContextMenu(press.x, press.y);
}

/** The menu opens under the finger, so the click the browser may send when it lifts must not pick an item. */
function swallowClick(at: Vec): void {
  const stop = (ev: MouseEvent) => {
    window.removeEventListener('click', stop, { capture: true });
    if (distance(at, { x: ev.clientX, y: ev.clientY }) > DOUBLE_TAP_DIST) return;
    ev.preventDefault();
    ev.stopPropagation();
  };
  window.addEventListener('click', stop, { capture: true });
  window.setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 450);
}
