import { prepareLayerMeasurements } from './artboard-loading.ts';
import { flushSync } from 'react-dom';
import { openTab } from '../panels/ChromePanels.tsx';
import { isVirtualId } from '@bogen/core';
import { session } from '../doc/session.ts';
import { sendCursor } from '../doc/presence.ts';
import { fmt, fmtPx, paddingOf, printSides, px } from '../lib/css-values.ts';
import { defaultTextStyle, normalizeSvgMarkup } from '../ops/clipboard.ts';
import { ensurePositioned, FLOW_PATCH, insertAt, isDropTarget, pageId, placement, positionPatchOf, topLevelOf } from '../ops/ops.ts';
import { camera } from '../state/camera.ts';
import { editor, type Tool } from '../state/store.ts';
import { apply, boxIntersectsRect, handleSigns, insertionIndex, insertionIndexWrapped, intersects, invert, nextZoomStop, normalizeDeg, pointInRect, rectFromPoints, resizeBox, rotateTo, rotation, scaleInto, contains, unionRects, type HandleId, type LocalBox, type Mat2, type Rect, type Vec } from './geometry.ts';
import { computedBox, cumulativeLinear, elOf, flowOf, idsAtPoint, isFlow, measure, parentLinear, rectOf, type FlowKind } from './measure.ts';
import { isConstrained, patchH, patchV, detectH, detectV } from '../lib/constraints.ts';
import { commitPathEdit, deleteSelectedPoint, endPathEdit, finishPen, insertPointNear, previewPathEdit, startPathEdit, togglePointSmooth, usePathEdit, usePen, type PathEdit } from './pen.ts';
import { simplify, smoothPath, type PathPoint } from './path.ts';
import { createPathLayer } from '../ops/ops.ts';
import { snapHandlePoint, snapMove, snapResize } from './snap.ts';
import { gridSnapRects } from '../ops/layout-grids.ts';
import { beginGradientDrag } from './gradient-drag.ts';
import { ui } from '../state/ui.ts';
import { settings } from '../state/settings.ts';
import { setCap, shapeToPath } from '../ops/vector.ts';
import { editingEl, startTextEdit, stopTextEdit } from './text-edit.ts';
import { tickOverlay } from './overlay-tick.ts';
import { t } from '../i18n/store.ts';
import { DEFAULT_SHADER, presetToAttrs, shaderPresets } from '../lib/shaders.ts';

const DRAG_THRESHOLD = 3;
const COMMIT_INTERVAL = 66;

let spaceDown = false;
export function setSpaceDown(v: boolean): void {
  spaceDown = v;
  if (camera.viewport) camera.viewport.classList.toggle('is-space', v);
}
export function isSpaceDown(): boolean {
  return spaceDown;
}
export function lastPointerPos(): { x: number; y: number } {
  return lastPointer;
}

interface Modifiers { shift: boolean; alt: boolean; ctrl: boolean }
const mods = (e: PointerEvent | MouseEvent): Modifiers => ({ shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey });

/** A running drag. `move` is called on each pointer move, `up` at the end, `cancel` on Escape. */
interface Drag {
  move: (e: PointerEvent) => void;
  up: (e: PointerEvent) => void;
  cancel?: () => void;
}

let drag: Drag | null = null;
let lastPointer: { x: number; y: number } = { x: 0, y: 0 };

export function isDragging(): boolean {
  return drag !== null;
}

export function cancelDrag(): boolean {
  if (!drag) return false;
  const d = drag;
  drag = null;
  d.cancel?.();
  editor().setGesture({});
  return true;
}

function startDrag(e: PointerEvent, d: Drag): void {
  drag = d;
  camera.viewport?.setPointerCapture?.(e.pointerId);
}

// Hit testing and depth rules

export function hitAt(clientX: number, clientY: number): string | null {
  const { snap } = session();
  for (const id of idsAtPoint(clientX, clientY)) {
    if (!snap.isLocked(id)) return id;
  }
  return null;
}

function pathTo(id: string): string[] {
  const { snap } = session();
  return [...snap.ancestors(id).reverse(), id];
}

function isGroup(id: string): boolean {
  const n = session().snap.nodes.get(id);
  // An instance is one thing to a plain click, like a group. Its inside is a double click away.
  if (n?.instanceOf !== undefined) return true;
  return Boolean(n && n.type === 'frame' && !n.artboard && /^Group\b/.test(n.name));
}

/** The layer a plain click means: the child of the top frame, or the depth one is already working at. */
export function resolveTarget(hit: string, deep: boolean): string {
  if (deep) return hit;
  const { snap } = session();
  const path = pathTo(hit);
  const selected = new Set(editor().selection);
  for (let i = path.length - 1; i >= 0; i--) {
    const at = path[i]!;
    if (selected.has(at)) return at;
  }
  const selectedParents = new Set([...selected].flatMap((s) => snap.nodes.get(s)?.parent ?? []));
  for (let i = path.length - 1; i >= 1; i--) {
    if (selectedParents.has(path[i - 1]!)) return path[i]!;
  }
  if (path.length === 1) return path[0]!;
  if (isGroup(path[0]!)) return path[0]!;
  return path[1]!;
}

// Entry points

export function onPointerDown(e: PointerEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest('[data-ui]')) return;
  camera.measureViewport();
  lastPointer = { x: e.clientX, y: e.clientY };

  const editing = editingEl();
  if (editing) {
    if (target === editing || editing.contains(target)) return;
    stopTextEdit();
  }
  if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();

  if (e.button === 1 || spaceDown || (e.button === 0 && editor().tool === 'hand')) {
    e.preventDefault();
    beginPan(e);
    return;
  }
  if (e.button === 2) return;
  if (e.button !== 0) return;
  e.preventDefault();

  // Path editing owns the canvas until it ends.
  if (editor().editingPathId) {
    pathEditDown(e, target);
    return;
  }

  if (target.dataset.gradient !== undefined) return beginGradientDrag(e, target, startDrag);
  const handle = target.dataset.handle as HandleId | undefined;
  if (handle) return beginResize(e, handle);
  if (target.dataset.rotate !== undefined) return beginRotate(e);
  if (target.dataset.gap !== undefined) return beginGapDrag(e);
  if (target.dataset.padding) return beginPaddingDrag(e, target.dataset.padding as 'top' | 'right' | 'bottom' | 'left');
  if (target.dataset.pin) {
    // Also when it is the thread already open and Comments the tab: a closed drawer opens on it.
    openTab('right', { activeThreadId: target.dataset.pin, rightTab: 'comments' });
    return;
  }
  const label = target.closest<HTMLElement>('[data-frame-label]')?.dataset.frameLabel;
  if (label) return pressLayer(e, label, null);

  const tool = editor().tool;
  switch (tool) {
    case 'move': return moveToolDown(e);
    case 'frame': case 'rect': case 'ellipse': case 'text': case 'shader': return beginDraw(e, tool);
    case 'line': return beginLine(e);
    case 'pen': return penDown(e);
    case 'pencil': return beginPencil(e);
    case 'comment': return commentDown(e);
    case 'zoom': return beginZoomBox(e);
    default: return undefined;
  }
}

export function onPointerMove(e: PointerEvent): void {
  lastPointer = { x: e.clientX, y: e.clientY };
  lastCtrl = e.ctrlKey || e.metaKey;
  const world = camera.worldAt(e.clientX, e.clientY);
  sendCursor(world);
  if (drag) {
    drag.move(e);
    return;
  }
  if (editor().tool === 'pen') {
    const pen = usePen.getState();
    if (pen.points.length) {
      const first = pen.points[0]!;
      const near = Math.hypot(first.x - world.x, first.y - world.y) * camera.value.z < 8;
      pen.set({ hover: world, closingHover: near });
    }
    return;
  }
  scheduleHover();
}

let hoverFrame = 0;
let lastCtrl = false;
function scheduleHover(): void {
  if (hoverFrame) return;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    if (drag) return;
    const state = editor();
    if (state.tool !== 'move' || state.editingTextId || state.editingPathId) {
      if (state.hoverId) state.set({ hoverId: null });
      return;
    }
    const hit = hitAt(lastPointer.x, lastPointer.y);
    const onUi = document.elementFromPoint(lastPointer.x, lastPointer.y)?.closest('[data-ui],[data-handle],[data-rotate]');
    const target = hit && !onUi ? resolveTarget(hit, false) : null;
    // Ctrl shows what a deep select would take, and alt measures to exactly that layer.
    const hover = hit && (state.altDown || lastCtrl) ? hit : target;
    if (hover !== state.hoverId) state.set({ hoverId: hover });
  });
}

export function onPointerLeave(): void {
  sendCursor(null);
  if (editor().hoverId) editor().set({ hoverId: null });
}

export function onPointerUp(e: PointerEvent): void {
  if (drag) {
    const d = drag;
    drag = null;
    try { camera.viewport?.releasePointerCapture?.(e.pointerId); } catch { /* already gone */ }
    d.up(e);
    tickOverlay();
  }
}

export function onDoubleClick(e: MouseEvent): void {
  // Pointer capture retargets the event to the viewport, so ask what is really under the pointer.
  const target = (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) as HTMLElement;
  if (target.closest('[data-ui]')) return;
  if (editor().editingTextId) return;
  if (editor().editingPathId) {
    const raw = target.dataset.pathPoint;
    if (raw) {
      const [p, s, i] = raw.split(',').map(Number) as [number, number, number];
      togglePointSmooth(p, s, i);
    }
    return;
  }
  const state = editor();
  const label = target.closest<HTMLElement>('[data-frame-label]')?.dataset.frameLabel;
  if (label) {
    state.set({ renamingLabelId: label });
    return;
  }
  if (state.tool !== 'move') {
    if (state.tool === 'pen') finishPen();
    return;
  }
  const { snap } = session();
  const hit = hitAt(e.clientX, e.clientY);
  if (!hit) return;
  const path = pathTo(hit);
  const current = state.selection.length === 1 ? state.selection[0]! : null;
  const at = current ? path.indexOf(current) : -1;
  if (at >= 0 && at < path.length - 1) {
    state.set({ selection: [path[at + 1]!] });
    return;
  }
  const leaf = at === path.length - 1 ? hit : resolveTarget(hit, false);
  const n = snap.nodes.get(leaf);
  if (!n) return;
  if (n.type === 'text') startTextEdit(leaf, { caretAt: { x: e.clientX, y: e.clientY } });
  else if (n.type === 'svg') startPathEdit(leaf);
  else state.set({ selection: [leaf] });
}

export function onWheel(e: WheelEvent): void {
  if ((e.target as HTMLElement).closest?.('[data-ui]')) return;
  e.preventDefault();
  camera.measureViewport();
  const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  const prefs = settings();
  if (e.ctrlKey || e.metaKey || prefs.wheel === 'zoom') {
    // Pinch arrives as ctrl+wheel with small deltas; a mouse wheel notch is about 100.
    const dy = Math.max(-50, Math.min(50, e.deltaY * scale)) * (prefs.zoomDirection === 'inverted' ? -1 : 1);
    camera.zoomAt(camera.value.z * Math.exp(-dy * 0.01), camera.fromClient(e.clientX, e.clientY));
    return;
  }
  if (e.shiftKey && !e.deltaX) camera.pan(-e.deltaY * scale, 0);
  else camera.pan(-e.deltaX * scale, -e.deltaY * scale);
}

// Pan

function beginPan(e: PointerEvent): void {
  let px0 = e.clientX;
  let py0 = e.clientY;
  camera.viewport?.classList.add('is-panning');
  const done = () => camera.viewport?.classList.remove('is-panning');
  startDrag(e, {
    move: (ev) => {
      camera.pan(ev.clientX - px0, ev.clientY - py0);
      px0 = ev.clientX;
      py0 = ev.clientY;
    },
    up: done,
    cancel: done,
  });
}

// Selection and move

function moveToolDown(e: PointerEvent): void {
  const state = editor();
  const hit = hitAt(e.clientX, e.clientY);
  if (!hit) {
    // A press inside the selection bounds of several layers still drags them.
    if (state.selection.length > 1) {
      const u = unionRects(state.selection.flatMap((id) => rectOf(id) ?? []));
      if (u && pointInRect(camera.worldAt(e.clientX, e.clientY), u)) return pressLayer(e, state.selection[0]!, null);
    }
    return beginMarquee(e, pageId(), e.shiftKey);
  }
  const deep = e.ctrlKey || e.metaKey;
  pressLayer(e, resolveTarget(hit, deep), hit);
}

/** A press on a layer: selects now or on release, then may become a move. */
function pressLayer(e: PointerEvent, target: string, hit: string | null): void {
  const state = editor();
  const { snap } = session();
  const wasSelected = state.selection.includes(target);
  const shift = e.shiftKey;
  const n = snap.nodes.get(target);
  // Dragging the empty area of an unselected top frame with children draws a marquee in it.
  const emptyAreaOfFrame = !wasSelected && !shift && hit === target && n?.type === 'frame' && n.instanceOf === undefined && snap.children(target).length > 0 && n.parent === state.pageId;
  if (emptyAreaOfFrame) {
    const startWorld = camera.worldAt(e.clientX, e.clientY);
    const start = { x: e.clientX, y: e.clientY };
    startDrag(e, {
      move: (ev) => {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
        drag = null;
        marqueeFrom(ev, target, startWorld, false);
      },
      up: () => editor().set({ selection: [target] }),
    });
    return;
  }
  if (!wasSelected) state.set({ selection: shift ? [...state.selection, target] : [target] });

  const start = { x: e.clientX, y: e.clientY };
  const startedSelected = wasSelected;
  startDrag(e, {
    move: (ev) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      drag = null;
      beginMove(ev, start);
    },
    up: () => {
      if (!startedSelected) return;
      const current = editor();
      if (shift) {
        current.set({ selection: current.selection.filter((id) => id !== target) });
        return;
      }
      if (current.selection.length > 1) current.set({ selection: [target] });
      else if (hit && hit !== target && snap.nodes.get(target)?.parent === current.pageId && !isGroup(target)) {
        // The top frame was selected and one of its children was clicked.
        const path = pathTo(hit);
        const next = path[1];
        if (next) current.set({ selection: [next] });
      }
    },
  });
}

interface MoveItem {
  id: string;
  flow: boolean;
  el: HTMLElement;
  startLeft: number;
  startTop: number;
  inverse: Mat2;
  start: Rect;
  centre: Vec;
  /** Pinned to more than its top left, so a move has to write what it is pinned to. */
  constrained: boolean;
}

function moveItems(ids: string[]): MoveItem[] {
  const out: MoveItem[] = [];
  for (const id of ids) {
    const el = elOf(id);
    const box = computedBox(id);
    const m = measure(id);
    if (!el || !box || !m) continue;
    const n = session().snap.nodes.get(id);
    out.push({ id, el, flow: isFlow(id), startLeft: box.left, startTop: box.top, inverse: invert(parentLinear(id)), start: m.rect, centre: { x: m.box.x + m.box.w / 2, y: m.box.y + m.box.h / 2 }, constrained: Boolean(n && isConstrained(n.style)) });
  }
  return out;
}

/** Rectangles worth snapping to: siblings, the parent, and top-level layers near the view. */
function snapTargets(exclude: Set<string>, parent: string | undefined): Rect[] {
  const { snap } = session();
  const view = camera.visibleWorld();
  const margin = view.w;
  const zone: Rect = { x: view.x - margin, y: view.y - margin, w: view.w + margin * 2, h: view.h + margin * 2 };
  const seen = new Set<string>();
  const out: Rect[] = [];
  const add = (id: string) => {
    if (exclude.has(id) || seen.has(id) || out.length > 1500) return;
    seen.add(id);
    const n = snap.nodes.get(id);
    if (!n || n.hidden) return;
    const r = rectOf(id);
    if (r && r.w + r.h > 0 && intersects(r, zone)) out.push(r);
  };
  if (parent && snap.nodes.has(parent)) {
    add(parent);
    snap.children(parent).forEach(add);
    snap.ancestors(parent).forEach(add);
  }
  snap.children(pageId()).forEach(add);
  // The columns and rows of the layout grids around it, while grids show.
  out.push(...gridSnapRects(parent && snap.nodes.has(parent) ? parent : undefined));
  return out;
}

const UNCLIP = 'bogen-unclip';

interface DropTarget {
  parent: string;
  flow: FlowKind;
  index?: number;
}

function descendantsOrSelf(ids: string[]): Set<string> {
  const { snap } = session();
  const out = new Set<string>();
  const walk = (id: string) => {
    out.add(id);
    snap.children(id).forEach(walk);
  };
  ids.forEach(walk);
  return out;
}

/** The container under the pointer, skipping what is being dragged. */
function dropTargetAt(clientX: number, clientY: number, moving: Set<string>): string {
  const { snap } = session();
  for (const id of idsAtPoint(clientX, clientY)) {
    if (moving.has(id) || snap.isLocked(id)) continue;
    const n = snap.nodes.get(id);
    if (!n || !isDropTarget(n)) continue;
    // An empty frame among flow siblings is a place to reorder around, not to nest into.
    const empty = !snap.children(id).length && n.style.display !== 'flex' && n.style.display !== 'grid';
    if (empty && !n.artboard && snap.nodes.has(n.parent) && flowOf(n.parent).kind === 'flow') continue;
    return id;
  }
  return pageId();
}

function flowDrop(parent: string, flow: Extract<FlowKind, { kind: 'flow' }>, pointer: Vec, moving: Set<string>): { index: number; line: { x0: number; y0: number; x1: number; y1: number } } {
  const { snap } = session();
  const sibs = snap.children(parent);
  const others = sibs.filter((id) => !moving.has(id) && isFlow(id));
  const rects = others.flatMap((id) => rectOf(id) ?? []);
  const parentRect = rectOf(parent)!;
  const idx = flow.wrap ? insertionIndexWrapped(rects, pointer, flow.axis) : insertionIndex(rects, pointer, flow.axis);
  const nextId = others[idx];
  const index = nextId ? sibs.indexOf(nextId) : sibs.length;
  const prev = rects[idx - 1];
  const next = rects[idx];
  let line;
  if (flow.axis === 'x') {
    const refY = next ?? prev;
    const x = prev && next && Math.abs(prev.y - next.y) < next.h ? (prev.x + prev.w + next.x) / 2 : next ? next.x - 1 : prev ? prev.x + prev.w + 1 : parentRect.x + 4;
    line = { x0: x, x1: x, y0: refY ? refY.y : parentRect.y, y1: refY ? refY.y + refY.h : parentRect.y + parentRect.h };
  } else {
    const refX = next ?? prev;
    const y = prev && next ? (prev.y + prev.h + next.y) / 2 : next ? next.y - 1 : prev ? prev.y + prev.h + 1 : parentRect.y + 4;
    line = { y0: y, y1: y, x0: refX ? refX.x : parentRect.x, x1: refX ? refX.x + refX.w : parentRect.x + parentRect.w };
  }
  return { index, line };
}

function beginMove(e: PointerEvent, startClient: Vec): void {
  const s = session();
  const { snap, doc } = s;
  let ids = topLevelOf(editor().selection);
  if (!ids.length) return;
  s.beginGesture();
  if (e.altKey) {
    let copies: string[] = [];
    flushSync(() => {
      s.tx(() => { copies = doc.duplicate(ids); });
    });
    ids = copies;
    editor().set({ selection: copies });
  }
  flushSync(() => prepareLayerMeasurements(ids, true));
  const items = moveItems(ids);
  // A layer in the flow of an instance keeps its place. Absolutely placed ones can move, as an override.
  if (!items.length || items.some((i) => i.flow && isVirtualId(i.id))) {
    s.endGesture();
    return;
  }
  const firstParent = snap.nodes.get(ids[0]!)?.parent;
  const moving = descendantsOrSelf(ids);
  const others = snapTargets(moving, firstParent);
  const startBounds = unionRects(items.map((i) => i.start))!;
  const startWorld = camera.worldAt(startClient.x, startClient.y);
  const absItems = items.filter((i) => !i.flow);
  let lastCommit = 0;
  let trailing = 0;
  let committed = false;
  let unclipped: HTMLElement[] = [];
  let delta: Vec = { x: 0, y: 0 };
  let drop: DropTarget | null = null;
  const anyFlow = items.some((i) => i.flow);

  const unclip = () => {
    if (unclipped.length) return;
    let cur = elOf(firstParent ?? '');
    while (cur && cur.dataset.bogenId) {
      cur.classList.add(UNCLIP);
      unclipped.push(cur);
      cur = cur.parentElement ?? undefined;
    }
  };
  const restoreClip = () => {
    for (const el of unclipped) el.classList.remove(UNCLIP);
    unclipped = [];
  };

  const write = () => {
    for (const it of items) {
      const local = apply(it.inverse, delta);
      if (it.flow) it.el.style.translate = `${fmt(local.x)}px ${fmt(local.y)}px`;
      else if (it.constrained) {
        for (const [k, v] of Object.entries(positionPatchOf(it.id, it.startLeft + local.x, it.startTop + local.y))) it.el.style.setProperty(k, v ?? '');
      } else {
        it.el.style.left = fmtPx(it.startLeft + local.x);
        it.el.style.top = fmtPx(it.startTop + local.y);
      }
    }
  };
  const commit = () => {
    if (!absItems.length) return;
    committed = true;
    s.tx(() => {
      for (const it of absItems) {
        const local = apply(it.inverse, delta);
        doc.updateStyle(it.id, it.constrained ? positionPatchOf(it.id, it.startLeft + local.x, it.startTop + local.y) : { left: fmtPx(it.startLeft + local.x), top: fmtPx(it.startTop + local.y), right: null, bottom: null });
      }
    });
  };

  const onMove = (ev: PointerEvent) => {
    const world = camera.worldAt(ev.clientX, ev.clientY);
    let dx = world.x - startWorld.x;
    let dy = world.y - startWorld.y;
    const lockAxis = ev.shiftKey ? (Math.abs(dx) > Math.abs(dy) ? 'y' : 'x') : null;
    if (lockAxis === 'x') dx = 0;
    if (lockAxis === 'y') dy = 0;

    const gesture: Parameters<ReturnType<typeof editor>['setGesture']>[0] = { active: 'move' };
    if (!ev.ctrlKey && !ev.metaKey) {
      const threshold = 6 / camera.value.z;
      const r = snapMove({ ...startBounds, x: startBounds.x + dx, y: startBounds.y + dy }, others, { threshold, pixel: true, lockX: lockAxis === 'x', lockY: lockAxis === 'y' });
      dx += r.dx;
      dy += r.dy;
      gesture.guides = r.guides;
      gesture.gaps = r.gaps;
    }
    delta = { x: dx, y: dy };

    // Where would this land?
    drop = null;
    const over = dropTargetAt(ev.clientX, ev.clientY, moving);
    const startParent = firstParent ?? pageId();
    const overFlow = snap.nodes.has(over) ? flowOf(over) : ({ kind: 'none' } as FlowKind);
    const leftParent = over !== startParent;
    if (overFlow.kind === 'flow') {
      const { index, line } = flowDrop(over, overFlow, world, moving);
      drop = { parent: over, flow: overFlow, index };
      gesture.drop = { line, ...(leftParent ? { container: rectOf(over) ?? undefined } : {}) } as typeof gesture.drop;
      gesture.guides = [];
      gesture.gaps = [];
    } else if (leftParent && (anyFlow || !startParentHolds(ids, world))) {
      drop = { parent: over, flow: overFlow };
      if (snap.nodes.has(over)) gesture.drop = { container: rectOf(over) ?? undefined } as typeof gesture.drop;
    } else if (anyFlow) {
      // A flow child still inside its non-flow parent: it stays put.
      drop = null;
    }
    if (leftParent) unclip();

    write();
    const m = unionRects(items.map((i) => ({ ...i.start, x: i.start.x + dx, y: i.start.y + dy })))!;
    gesture.label = { text: `${fmt(m.x)}, ${fmt(m.y)}`, x: m.x + m.w / 2, y: m.y + m.h };
    editor().setGesture(gesture);
    tickOverlay();
    const now = performance.now();
    clearTimeout(trailing);
    if (now - lastCommit > COMMIT_INTERVAL) {
      lastCommit = now;
      commit();
    } else {
      // A pause in the drag still reaches the inspector and the other people in the file.
      trailing = window.setTimeout(commit, COMMIT_INTERVAL);
    }
  };

  const finish = (ev: PointerEvent) => {
    clearTimeout(trailing);
    restoreClip();
    for (const it of items) if (it.flow) it.el.style.translate = '';
    commit();
    const d = drop;
    if (d) applyDrop(items, d, delta);
    s.endGesture();
    editor().setGesture({});
    void ev;
  };

  const cancel = () => {
    clearTimeout(trailing);
    restoreClip();
    for (const it of items) {
      const n = snap.nodes.get(it.id);
      it.el.style.translate = n?.style.translate ?? '';
    }
    if (committed) {
      s.endGesture();
      s.undo.undo();
      s.undo.redoStack.pop();
    } else {
      for (const it of items) {
        const n = snap.nodes.get(it.id);
        it.el.style.left = n?.style.left ?? '';
        it.el.style.top = n?.style.top ?? '';
      }
      s.endGesture();
    }
  };

  drag = { move: onMove, up: finish, cancel };
  onMove(e);
}

function startParentHolds(ids: string[], world: Vec): boolean {
  const { snap } = session();
  const parent = snap.nodes.get(ids[0]!)?.parent;
  if (!parent || !snap.nodes.has(parent)) return false;
  const r = rectOf(parent);
  return Boolean(r && pointInRect(world, r));
}

function applyDrop(items: MoveItem[], drop: DropTarget, delta: Vec): void {
  if (items.some((i) => isVirtualId(i.id))) return;
  const s = session();
  const { snap, doc } = s;
  const ids = items.map((i) => i.id);
  const parent = drop.parent;
  const sameParent = items.every((i) => snap.nodes.get(i.id)?.parent === parent);
  // Measure before anything moves in the document.
  const styles = new Map<string, Record<string, string | null>>();
  for (const it of items) {
    if (drop.flow.kind === 'flow') {
      const n = snap.nodes.get(it.id)!;
      const patch: Record<string, string | null> = { ...FLOW_PATCH };
      // A layer entering flow keeps its size when it was a positioned one.
      if (!sameParent && n.style.position === 'absolute') {
        const m = measure(it.id);
        if (m) {
          patch.width = n.style.width ?? fmtPx(m.box.w);
          if (n.style.height || n.type !== 'text') patch.height = n.style.height ?? fmtPx(m.box.h);
        }
      }
      styles.set(it.id, patch);
    } else if (!sameParent) {
      styles.set(it.id, placement(it.id, parent, it.flow ? { x: it.centre.x + delta.x, y: it.centre.y + delta.y } : undefined));
    }
  }
  flushSync(() => {
    s.tx(() => {
      if (drop.flow.kind !== 'flow' && snap.nodes.has(parent)) ensurePositioned(parent);
      for (const it of items) {
        const st = styles.get(it.id);
        if (st) doc.updateStyle(it.id, st);
      }
      if (!sameParent || drop.index !== undefined) doc.move(ids, parent, drop.index);
    });
  });
}

// Marquee

function beginMarquee(e: PointerEvent, scope: string, additive: boolean): void {
  const startWorld = camera.worldAt(e.clientX, e.clientY);
  const start = { x: e.clientX, y: e.clientY };
  const before = additive ? editor().selection : [];
  startDrag(e, {
    move: (ev) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      drag = null;
      marqueeFrom(ev, scope, startWorld, additive);
    },
    up: () => {
      if (!additive) editor().set({ selection: before, hoverId: null });
    },
  });
}

function marqueeFrom(e: PointerEvent, scope: string, startWorld: Vec, additive: boolean): void {
  const { snap } = session();
  const base = additive ? editor().selection : [];
  // Rectangles are read once. Layout does not change during a marquee.
  const cands = snap.children(scope).flatMap((id) => {
    const n = snap.nodes.get(id);
    if (!n || n.hidden || n.locked) return [];
    const m = measure(id);
    return m ? [{ id, r: m.rect, box: m.box, artboard: Boolean(n.artboard) }] : [];
  });
  let frame = 0;
  let lastSel = '';
  const move = (ev: PointerEvent) => {
    const m = rectFromPoints(startWorld, camera.worldAt(ev.clientX, ev.clientY));
    editor().setGesture({ marquee: m });
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const picked = cands.filter((c) => (c.artboard && scope === pageId() ? contains(m, c.r) : c.box.rot ? boxIntersectsRect(c.box, m) : intersects(m, c.r))).map((c) => c.id);
      const next = [...new Set([...base, ...picked])];
      const key = next.join();
      if (key !== lastSel) {
        lastSel = key;
        editor().set({ selection: next });
      }
    });
  };
  drag = {
    move,
    up: () => {
      cancelAnimationFrame(frame);
      editor().setGesture({});
    },
    cancel: () => {
      cancelAnimationFrame(frame);
      editor().set({ selection: base });
    },
  };
  move(e);
}

// Resize

interface ResizeItem {
  id: string;
  el: HTMLElement;
  flow: boolean;
  isText: boolean;
  isSvg: boolean;
  box: LocalBox;
  world: Rect;
  /** The box as it is on screen. */
  worldBox: LocalBox;
  inverse: Mat2;
  hadHeight: boolean;
  /** Keeps its aspect ratio: CSS works the height out from the width. */
  ratio: boolean;
  constraints: { hk: ReturnType<typeof detectH>; vk: ReturnType<typeof detectV>; parentW: number; parentH: number } | null;
}

function beginResize(e: PointerEvent, handle: HandleId): void {
  // A proxy is only approximate; explicit geometry edits always measure the real selected content first.
  flushSync(() => prepareLayerMeasurements(editor().selection, true));
  const s = session();
  const { snap, doc } = s;
  const ids = topLevelOf(editor().selection);
  const items: ResizeItem[] = [];
  for (const id of ids) {
    const el = elOf(id);
    const box = computedBox(id);
    const m = measure(id);
    const n = snap.nodes.get(id);
    if (!el || !box || !m || !n) continue;
    const self = cumulativeLinear(id);
    const parent = parentLinear(id);
    const rot = normalizeDeg(Math.atan2(self.b, self.a) * (180 / Math.PI) - Math.atan2(parent.b, parent.a) * (180 / Math.PI));
    items.push({ id, el, flow: isFlow(id), isText: n.type === 'text', isSvg: n.type === 'svg', box: { x: box.left, y: box.top, w: box.width, h: box.height, rot }, world: m.rect, worldBox: m.box, inverse: invert(parent), hadHeight: Boolean(n.style.height), ratio: Boolean(n.style.aspectRatio && n.style.aspectRatio !== 'auto'), constraints: isConstrained(n.style) ? { hk: detectH(n.style), vk: detectV(n.style), parentW: elOf(n.parent)?.clientWidth ?? 0, parentH: elOf(n.parent)?.clientHeight ?? 0 } : null });
  }
  if (!items.length) return;

  s.beginGesture();
  // Vector markup has to fill its layer for a resize to resize the drawing.
  s.tx(() => {
    for (const it of items) {
      if (!it.isSvg) continue;
      const svg = snap.nodes.get(it.id)?.svg;
      if (!svg || /<svg[^>]*\swidth="100%"/.test(svg)) continue;
      doc.updateFields(it.id, { svg: normalizeSvgMarkup(svg).svg });
    }
  });

  const startWorld = camera.worldAt(e.clientX, e.clientY);
  const { sx, sy } = handleSigns(handle);
  const single = items.length === 1 ? items[0]! : null;
  const groupStart = unionRects(items.map((i) => i.world))!;
  const others = snapTargets(descendantsOrSelf(ids), snap.nodes.get(ids[0]!)?.parent);
  const snappable = !single || (Math.abs(single.box.rot) < 0.01 && single.inverse.a === 1 && single.inverse.d === 1 && single.inverse.b === 0);
  let lastCommit = 0;
  let current = new Map<string, LocalBox>();

  /** Where a dragged handle of a rotated layer goes, snapped, as a movement in the world. */
  const snappedRotatedDelta = (it: ResizeItem, moved: Vec, guides: { value: ReturnType<typeof snapHandlePoint>['guides'] }): Vec => {
    const r = rotation(it.worldBox.rot);
    const c = { x: it.worldBox.x + it.worldBox.w / 2, y: it.worldBox.y + it.worldBox.h / 2 };
    const start = apply(r, { x: (sx * it.worldBox.w) / 2, y: (sy * it.worldBox.h) / 2 });
    const along = sx === 0 || sy === 0 ? apply(r, { x: sx, y: sy }) : null;
    const travel = along ? { x: along.x * (moved.x * along.x + moved.y * along.y), y: along.y * (moved.x * along.x + moved.y * along.y) } : moved;
    const point = { x: c.x + start.x + travel.x, y: c.y + start.y + travel.y };
    const snapped = snapHandlePoint(point, along, others, 6 / camera.value.z);
    guides.value = snapped.guides;
    return { x: travel.x + snapped.dx, y: travel.y + snapped.dy };
  };

  const computeSingle = (it: ResizeItem, ev: PointerEvent): LocalBox => {
    const world = camera.worldAt(ev.clientX, ev.clientY);
    const worldMove = { x: world.x - startWorld.x, y: world.y - startWorld.y };
    const rotatedSnap = !snappable && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
    const rotatedGuides: { value: ReturnType<typeof snapHandlePoint>['guides'] } = { value: [] };
    const delta = apply(it.inverse, rotatedSnap ? snappedRotatedDelta(it, worldMove, rotatedGuides) : worldMove);
    let next = resizeBox(it.box, handle, delta, { keepRatio: ev.shiftKey || it.ratio, fromCentre: ev.altKey, min: 1 });
    if (snappable && !it.ratio && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey) {
      // Snap in world space, then carry the correction back to layout coordinates.
      const wx = it.world.x + (next.x - it.box.x);
      const wy = it.world.y + (next.y - it.box.y);
      const r = snapResize({ x: wx, y: wy, w: next.w, h: next.h }, { l: sx < 0, r: sx > 0, t: sy < 0, b: sy > 0 }, others, 6 / camera.value.z);
      next = { x: next.x + (r.box.x - wx), y: next.y + (r.box.y - wy), w: r.box.w, h: r.box.h, rot: next.rot };
      editor().setGesture({ active: 'resize', guides: r.guides, label: { text: `${fmt(next.w)} × ${fmt(next.h)}`, x: wx + next.w / 2, y: wy + next.h } });
    } else {
      const m = measure(it.id);
      editor().setGesture({ active: 'resize', guides: rotatedGuides.value, label: m ? { text: `${fmt(next.w)} × ${fmt(next.h)}`, x: m.rect.x + m.rect.w / 2, y: m.rect.y + m.rect.h } : undefined });
    }
    return next;
  };

  /** What the box means for a layer pinned to more than its top left, one axis at a time. */
  const pinned = (it: ResizeItem, b: LocalBox): Record<string, string | null> => {
    const c = it.constraints;
    if (!c) return {};
    return { ...(c.hk !== 'left' ? patchH(c.hk, b.x, b.w, c.parentW) : {}), ...(c.vk !== 'top' ? patchV(c.vk, b.y, b.h, c.parentH) : {}) };
  };

  const writeDom = (it: ResizeItem, b: LocalBox) => {
    if (sx !== 0 || !single || it.ratio) it.el.style.width = fmtPx(b.w);
    if (!it.ratio && (sy !== 0 || !single || it.box.rot !== 0)) it.el.style.height = fmtPx(b.h);
    if (!it.flow) {
      it.el.style.left = fmtPx(b.x);
      it.el.style.top = fmtPx(b.y);
    }
    for (const [k, v] of Object.entries(pinned(it, b))) it.el.style.setProperty(k, v ?? '');
  };

  const commit = () => {
    s.tx(() => {
      for (const it of items) {
        const b = current.get(it.id);
        if (!b) continue;
        const patch: Record<string, string | null> = {};
        if (sx !== 0 || !single || it.ratio) {
          patch.width = fmtPx(b.w);
          patch.flexGrow = null;
          patch.flexBasis = null;
        }
        if (it.ratio) patch.height = null;
        else if (sy !== 0 || !single || it.box.rot !== 0) {
          patch.height = fmtPx(b.h);
          patch.alignSelf = null;
        }
        if (!it.flow) {
          patch.left = fmtPx(b.x);
          patch.top = fmtPx(b.y);
        }
        doc.updateStyle(it.id, { ...patch, ...pinned(it, b) });
      }
    });
  };

  startDrag(e, {
    move: (ev) => {
      const next = new Map<string, LocalBox>();
      if (single) {
        next.set(single.id, computeSingle(single, ev));
      } else {
        const world = camera.worldAt(ev.clientX, ev.clientY);
        const delta = { x: world.x - startWorld.x, y: world.y - startWorld.y };
        const g = resizeBox({ ...groupStart, rot: 0 }, handle, delta, { keepRatio: ev.shiftKey, fromCentre: ev.altKey, min: 1 });
        for (const it of items) {
          const to = scaleInto(it.world, groupStart, g);
          const local = apply(it.inverse, { x: to.x - it.world.x, y: to.y - it.world.y });
          next.set(it.id, { x: it.box.x + local.x, y: it.box.y + local.y, w: Math.max(1, it.box.w * (groupStart.w ? g.w / groupStart.w : 1)), h: Math.max(1, it.box.h * (groupStart.h ? g.h / groupStart.h : 1)), rot: it.box.rot });
        }
        editor().setGesture({ active: 'resize', label: { text: `${fmt(g.w)} × ${fmt(g.h)}`, x: g.x + g.w / 2, y: g.y + g.h } });
      }
      current = next;
      for (const it of items) {
        const b = next.get(it.id);
        if (b) writeDom(it, b);
      }
      tickOverlay();
      const now = performance.now();
      if (now - lastCommit > COMMIT_INTERVAL) {
        lastCommit = now;
        commit();
      }
    },
    up: () => {
      if (current.size) commit();
      s.endGesture();
      editor().setGesture({});
    },
    cancel: () => {
      s.endGesture();
      s.undo.undo();
      s.undo.redoStack.pop();
      for (const it of items) {
        const n = snap.nodes.get(it.id);
        it.el.style.width = n?.style.width ?? '';
        it.el.style.height = n?.style.height ?? '';
        it.el.style.left = n?.style.left ?? '';
        it.el.style.top = n?.style.top ?? '';
      }
    },
  });
}

// Rotate

function beginRotate(e: PointerEvent): void {
  flushSync(() => prepareLayerMeasurements(editor().selection, true));
  const s = session();
  const { snap, doc } = s;
  const ids = topLevelOf(editor().selection);
  const measured = ids.flatMap((id) => measure(id) ?? []);
  if (!measured.length) return;
  const group = unionRects(measured.map((m) => m.rect))!;
  const single = measured.length === 1;
  const centre = single
    ? { x: measured[0]!.box.x + measured[0]!.box.w / 2, y: measured[0]!.box.y + measured[0]!.box.h / 2 }
    : { x: group.x + group.w / 2, y: group.y + group.h / 2 };
  const starts = measured.map((m) => {
    const n = snap.nodes.get(m.id)!;
    const box = computedBox(m.id)!;
    return { id: m.id, flow: isFlow(m.id), rotate: parseFloat(n.style.rotate ?? '0') || 0, left: box.left, top: box.top, cx: m.box.x + m.box.w / 2, cy: m.box.y + m.box.h / 2, inverse: invert(parentLinear(m.id)) };
  });
  const from = camera.worldAt(e.clientX, e.clientY);
  s.beginGesture();
  let last = 0;
  let current = 0;
  const commit = () => {
    s.tx(() => {
      const r = rotation(current);
      for (const st of starts) {
        const patch: Record<string, string | null> = { rotate: `${fmt(normalizeDeg(st.rotate + current))}deg` };
        if (!single && !st.flow) {
          const q = apply(r, { x: st.cx - centre.x, y: st.cy - centre.y });
          const local = apply(st.inverse, { x: q.x + centre.x - st.cx, y: q.y + centre.y - st.cy });
          patch.left = fmtPx(st.left + local.x);
          patch.top = fmtPx(st.top + local.y);
        }
        doc.updateStyle(st.id, patch);
      }
    });
  };
  startDrag(e, {
    move: (ev) => {
      current = rotateTo(0, centre, from, camera.worldAt(ev.clientX, ev.clientY), ev.shiftKey ? 15 : 0);
      const shown = single ? normalizeDeg(starts[0]!.rotate + current) : current;
      const world = camera.worldAt(ev.clientX, ev.clientY);
      editor().setGesture({ active: 'rotate', label: { text: `${fmt(shown, 1)}°`, x: world.x, y: world.y + 16 / camera.value.z } });
      const now = performance.now();
      if (now - last > 16) {
        last = now;
        commit();
      }
      tickOverlay();
    },
    up: () => {
      commit();
      s.endGesture();
      editor().setGesture({});
    },
    cancel: () => {
      s.endGesture();
      s.undo.undo();
      s.undo.redoStack.pop();
    },
  });
}

// Gap and padding handles

function beginGapDrag(e: PointerEvent): void {
  const s = session();
  const id = editor().selection[0];
  if (!id) return;
  const n = s.snap.nodes.get(id);
  const flow = flowOf(id);
  const el = elOf(id);
  if (!n || flow.kind !== 'flow' || !el) return;
  const axis = flow.axis;
  const cs = getComputedStyle(el);
  const start = parseFloat(axis === 'x' ? cs.columnGap : cs.rowGap) || 0;
  const count = Math.max(1, s.snap.children(id).filter((c) => isFlow(c)).length - 1);
  const from = camera.worldAt(e.clientX, e.clientY);
  s.beginGesture();
  startDrag(e, {
    move: (ev) => {
      const w = camera.worldAt(ev.clientX, ev.clientY);
      const d = axis === 'x' ? w.x - from.x : w.y - from.y;
      const justifiedFactor = 2 / Math.max(2, count);
      const gap = Math.max(0, Math.round(start + d * justifiedFactor * 2));
      s.tx(() => s.doc.updateStyle(id, { gap: `${gap}px`, rowGap: null, columnGap: null }));
      editor().setGesture({ label: { text: t('Gap {gap}', { gap }), x: w.x, y: w.y + 14 / camera.value.z } });
      tickOverlay();
    },
    up: () => {
      s.endGesture();
      editor().setGesture({});
    },
    cancel: () => {
      s.endGesture();
      s.undo.undo();
      s.undo.redoStack.pop();
    },
  });
}

function beginPaddingDrag(e: PointerEvent, side: 'top' | 'right' | 'bottom' | 'left'): void {
  const s = session();
  const id = editor().selection[0];
  if (!id) return;
  const n = s.snap.nodes.get(id);
  if (!n) return;
  const start = paddingOf(n.style);
  const from = camera.worldAt(e.clientX, e.clientY);
  s.beginGesture();
  startDrag(e, {
    move: (ev) => {
      const w = camera.worldAt(ev.clientX, ev.clientY);
      const d = side === 'left' ? w.x - from.x : side === 'right' ? from.x - w.x : side === 'top' ? w.y - from.y : from.y - w.y;
      const v = Math.max(0, Math.round(start[side] + d));
      const next = { ...start, [side]: v };
      if (ev.altKey) {
        if (side === 'left' || side === 'right') { next.left = v; next.right = v; }
        else { next.top = v; next.bottom = v; }
      }
      if (ev.shiftKey) { next.top = v; next.right = v; next.bottom = v; next.left = v; }
      const printed = printSides({ top: `${next.top}px`, right: `${next.right}px`, bottom: `${next.bottom}px`, left: `${next.left}px` });
      s.tx(() => s.doc.updateStyle(id, { padding: printed, paddingTop: null, paddingRight: null, paddingBottom: null, paddingLeft: null, paddingInline: null, paddingBlock: null }));
      editor().setGesture({ label: { text: t('Padding {value}', { value: v }), x: w.x, y: w.y + 14 / camera.value.z } });
      tickOverlay();
    },
    up: () => {
      s.endGesture();
      editor().setGesture({});
    },
    cancel: () => {
      s.endGesture();
      s.undo.undo();
      s.undo.redoStack.pop();
    },
  });
}

// Drawing

const SHAPE_NAMES: Partial<Record<Tool, string>> = { frame: 'Frame', rect: 'Rectangle', ellipse: 'Ellipse', shader: 'Shader' };

/** Deepest frame a new layer starting here belongs in, or the page. */
function containerAt(clientX: number, clientY: number): string {
  const { snap } = session();
  for (const id of idsAtPoint(clientX, clientY)) {
    const n = snap.nodes.get(id);
    if (!n || snap.isLocked(id)) continue;
    if (isDropTarget(n)) return id;
  }
  return pageId();
}

async function drawnShaderAttrs(): Promise<Record<string, string>> {
  const presets = await shaderPresets(DEFAULT_SHADER);
  const first = presets[0];
  return first ? presetToAttrs(DEFAULT_SHADER, first) : { type: DEFAULT_SHADER };
}

function beginDraw(e: PointerEvent, tool: Tool): void {
  const startWorld = camera.worldAt(e.clientX, e.clientY);
  const parent = containerAt(e.clientX, e.clientY);
  const others = snapTargets(new Set(), parent);
  const start = { x: e.clientX, y: e.clientY };
  let moved = false;
  let rect: Rect = { x: startWorld.x, y: startWorld.y, w: 0, h: 0 };

  const update = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
    moved = true;
    const w = camera.worldAt(ev.clientX, ev.clientY);
    let dx = w.x - startWorld.x;
    let dy = w.y - startWorld.y;
    if (ev.shiftKey) {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      dx = Math.sign(dx || 1) * m;
      dy = Math.sign(dy || 1) * m;
    }
    let r: Rect;
    if (ev.altKey) r = { x: startWorld.x - Math.abs(dx), y: startWorld.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
    else r = rectFromPoints(startWorld, { x: startWorld.x + dx, y: startWorld.y + dy });
    const edges = { l: dx < 0, r: dx > 0, t: dy < 0, b: dy > 0 };
    const snapped = ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey ? { box: r, guides: [] } : snapResize(r, edges, others, 6 / camera.value.z);
    rect = snapped.box;
    editor().setGesture({ drawing: rect, guides: snapped.guides, label: { text: `${fmt(rect.w)} × ${fmt(rect.h)}`, x: rect.x + rect.w / 2, y: rect.y + rect.h } });
  };

  startDrag(e, {
    move: update,
    up: () => {
      editor().setGesture({});
      void createDrawn(tool, parent, moved ? rect : null, startWorld);
    },
    cancel: () => editor().set({ tool: 'move' }),
  });
}

async function createDrawn(tool: Tool, parent: string, rect: Rect | null, at: Vec): Promise<void> {
  const s = session();
  const { snap } = s;
  if (tool === 'text') {
    const size = 16;
    const world = rect ?? { x: Math.round(at.x), y: Math.round(at.y - size * 0.7) };
    s.beginGesture();
    const id = insertAt(parent, {
      type: 'text', tag: 'p', name: 'Text', text: '',
      style: { ...defaultTextStyle(), ...(rect ? { width: fmtPx(rect.w) } : {}) },
    }, world);
    editor().set({ tool: 'move' });
    startTextEdit(id, { created: true });
    return;
  }
  const defaults: Record<string, { w: number; h: number }> = { frame: { w: 400, h: 300 }, rect: { w: 100, h: 100 }, ellipse: { w: 100, h: 100 }, shader: { w: 400, h: 300 } };
  const def = defaults[tool]!;
  const r = rect && rect.w >= 1 && rect.h >= 1 ? rect : { x: Math.round(at.x - def.w / 2), y: Math.round(at.y - def.h / 2), w: def.w, h: def.h };
  const onPage = !snap.nodes.has(parent);
  const size = { width: fmtPx(r.w), height: fmtPx(r.h) };
  const name = SHAPE_NAMES[tool] ?? 'Frame';
  let id = '';
  if (tool === 'frame') id = insertAt(parent, { type: 'frame', name, artboard: onPage, style: { ...size, ...(onPage ? { backgroundColor: '#ffffff', overflow: 'hidden' } : {}) } }, r);
  else if (tool === 'rect') id = insertAt(parent, { type: 'frame', name, style: { ...size, backgroundColor: '#d9d9d9' } }, r);
  else if (tool === 'ellipse') id = insertAt(parent, { type: 'frame', name, style: { ...size, backgroundColor: '#d9d9d9', borderRadius: '50%' } }, r);
  else if (tool === 'shader') {
    const attrs = await drawnShaderAttrs();
    id = insertAt(parent, { type: 'shader', name, attrs, style: size }, r);
  }
  editor().set({ selection: id ? [id] : [], tool: 'move' });
}

function beginLine(e: PointerEvent): void {
  const startWorld = camera.worldAt(e.clientX, e.clientY);
  const parent = containerAt(e.clientX, e.clientY);
  let end = startWorld;
  startDrag(e, {
    move: (ev) => {
      const w = camera.worldAt(ev.clientX, ev.clientY);
      let dx = w.x - startWorld.x;
      let dy = w.y - startWorld.y;
      if (ev.shiftKey) {
        const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
        const len = Math.hypot(dx, dy);
        dx = Math.cos(a) * len;
        dy = Math.sin(a) * len;
      }
      end = { x: startWorld.x + dx, y: startWorld.y + dy };
      editor().setGesture({ linePreview: { x0: startWorld.x, y0: startWorld.y, x1: end.x, y1: end.y }, label: { text: `${fmt(Math.hypot(dx, dy))}`, x: end.x, y: end.y + 8 / camera.value.z } });
    },
    up: () => {
      editor().setGesture({});
      const dx = end.x - startWorld.x;
      const dy = end.y - startWorld.y;
      const len = Math.hypot(dx, dy) || 100;
      const angle = Math.hypot(dx, dy) ? Math.atan2(dy, dx) * (180 / Math.PI) : 0;
      const cx = startWorld.x + (Math.hypot(dx, dy) ? dx / 2 : 50);
      const cy = startWorld.y + dy / 2;
      const h = 2;
      const id = insertAt(parent, { type: 'frame', name: 'Line', style: { width: fmtPx(len), height: fmtPx(h), backgroundColor: '#111111', ...(Math.abs(angle) > 0.01 ? { rotate: `${fmt(angle)}deg` } : {}) } }, { x: cx - len / 2, y: cy - h / 2 });
      editor().set({ selection: [id], tool: 'move' });
      if (ui().arrowLine) {
        ui().set({ arrowLine: false });
        const path = shapeToPath([id])[0];
        if (path) setCap(path, 'end', 'arrow');
      }
    },
    cancel: () => editor().set({ tool: 'move' }),
  });
}

function beginPencil(e: PointerEvent): void {
  const start = camera.worldAt(e.clientX, e.clientY);
  const parent = pageId();
  const points: Vec[] = [start];
  startDrag(e, {
    move: (ev) => {
      const w = camera.worldAt(ev.clientX, ev.clientY);
      const last = points.at(-1)!;
      if (Math.hypot(w.x - last.x, w.y - last.y) * camera.value.z < 1.5) return;
      points.push(w);
      editor().setGesture({ pencil: points.map((p, i) => `${i ? 'L' : 'M'}${fmt(p.x)} ${fmt(p.y)}`).join('') });
    },
    up: () => {
      editor().setGesture({});
      if (points.length < 2) return;
      const reduced = simplify(points, 1 / camera.value.z);
      const id = createPathLayer([smoothPath(reduced)], parent, 'Stroke');
      editor().set({ selection: [id], tool: 'move' });
    },
    cancel: () => editor().set({ tool: 'move' }),
  });
}

function penDown(e: PointerEvent): void {
  const pen = usePen.getState();
  const world = camera.worldAt(e.clientX, e.clientY);
  if (pen.points.length >= 2) {
    const first = pen.points[0]!;
    if (Math.hypot(first.x - world.x, first.y - world.y) * camera.value.z < 8) {
      finishPen(true);
      return;
    }
  }
  const at: PathPoint = { x: Math.round(world.x * 2) / 2, y: Math.round(world.y * 2) / 2 };
  pen.set({ points: [...pen.points, at], hover: world });
  const index = pen.points.length;
  const start = { x: e.clientX, y: e.clientY };
  let dragging = false;
  startDrag(e, {
    move: (ev) => {
      if (!dragging && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      dragging = true;
      const w = camera.worldAt(ev.clientX, ev.clientY);
      const cur = usePen.getState();
      const next = cur.points.map((p, i) => (i === index ? { ...p, hx2: w.x, hy2: w.y, hx1: 2 * p.x - w.x, hy1: 2 * p.y - w.y } : p));
      cur.set({ points: next, hover: w });
    },
    up: () => {},
  });
}

function commentDown(e: PointerEvent): void {
  const world = camera.worldAt(e.clientX, e.clientY);
  const hit = hitAt(e.clientX, e.clientY);
  let pending: { x: number; y: number; nodeId?: string } = { x: world.x, y: world.y };
  if (hit) {
    const r = rectOf(hit);
    if (r) pending = { x: world.x - r.x, y: world.y - r.y, nodeId: hit };
  }
  editor().set({ pendingComment: pending, tool: 'move', rightTab: editor().rightTab });
}

function beginZoomBox(e: PointerEvent): void {
  const startWorld = camera.worldAt(e.clientX, e.clientY);
  const start = { x: e.clientX, y: e.clientY };
  let box: Rect | null = null;
  startDrag(e, {
    move: (ev) => {
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_THRESHOLD) return;
      box = rectFromPoints(startWorld, camera.worldAt(ev.clientX, ev.clientY));
      editor().setGesture({ zoomBox: box });
    },
    up: (ev) => {
      editor().setGesture({});
      if (box) camera.fit(box, 256, 8);
      else {
        const anchor = camera.fromClient(ev.clientX, ev.clientY);
        camera.zoomAt(nextZoomStop(camera.value.z, ev.altKey ? -1 : 1), anchor);
      }
    },
  });
}

// Path editing

function localFromClient(id: string, clientX: number, clientY: number): Vec | null {
  const m = measure(id);
  if (!m) return null;
  const w = camera.worldAt(clientX, clientY);
  const cx = m.box.x + m.box.w / 2;
  const cy = m.box.y + m.box.h / 2;
  const q = apply(rotation(-m.box.rot), { x: w.x - cx, y: w.y - cy });
  return { x: q.x + m.box.w / 2, y: q.y + m.box.h / 2 };
}

function pathEditDown(e: PointerEvent, target: HTMLElement): void {
  const store = usePathEdit.getState();
  const edit = store.edit;
  if (!edit) return;
  const s = session();
  const pointRaw = target.dataset.pathPoint;
  const handleRaw = target.dataset.pathHandle;
  if (pointRaw || handleRaw) {
    const [p, sub, i, which] = (pointRaw ?? handleRaw)!.split(',').map(Number) as [number, number, number, number | undefined];
    const original: PathEdit = { ...edit, selected: { path: p, sub, point: i } };
    store.set(original);
    let latest = original;
    let changed = false;
    s.beginGesture();
    startDrag(e, {
      move: (ev) => {
        const local = localFromClient(edit.id, ev.clientX, ev.clientY);
        if (!local) return;
        changed = true;
        const paths = original.paths.map((pp, pi) => (pi !== p ? pp : pp.map((q, si) => {
          if (si !== sub) return q;
          return {
            ...q,
            points: q.points.map((pt, ii) => {
              if (ii !== i) return pt;
              if (handleRaw) {
                if (which === 1) {
                  const mirror = ev.altKey || pt.hx2 === undefined ? {} : { hx2: 2 * pt.x - local.x, hy2: 2 * pt.y - local.y };
                  return { ...pt, hx1: local.x, hy1: local.y, ...mirror };
                }
                const mirror = ev.altKey || pt.hx1 === undefined ? {} : { hx1: 2 * pt.x - local.x, hy1: 2 * pt.y - local.y };
                return { ...pt, hx2: local.x, hy2: local.y, ...mirror };
              }
              const dx = local.x - pt.x;
              const dy = local.y - pt.y;
              return {
                x: local.x, y: local.y,
                ...(pt.hx1 !== undefined ? { hx1: pt.hx1 + dx, hy1: pt.hy1! + dy } : {}),
                ...(pt.hx2 !== undefined ? { hx2: pt.hx2 + dx, hy2: pt.hy2! + dy } : {}),
              };
            }),
          };
        })));
        latest = { ...original, paths };
        usePathEdit.getState().set(latest);
        previewPathEdit(latest);
        tickOverlay();
      },
      up: () => {
        if (changed) commitPathEdit(latest);
        s.endGesture();
        tickOverlay();
      },
    });
    return;
  }
  const local = localFromClient(edit.id, e.clientX, e.clientY);
  if (local && insertPointNear(local, 6 / camera.value.z)) {
    tickOverlay();
    return;
  }
  // A click away from the vector ends node editing.
  const hit = hitAt(e.clientX, e.clientY);
  if (hit !== edit.id) endPathEdit();
  else store.set({ ...edit, selected: null });
}

export function pathEditKey(e: KeyboardEvent): boolean {
  if (!editor().editingPathId) return false;
  if (e.key === 'Escape' || e.key === 'Enter') {
    endPathEdit();
    return true;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    deleteSelectedPoint();
    return true;
  }
  return false;
}

export { px };
