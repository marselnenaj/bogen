import type { BogenNode } from '@bogen/core';
import { session } from '../doc/session.ts';
import { interpolatedStop, parseFills, printFills, type Fill, type GradientStop } from '../lib/fills.ts';
import { camera } from '../state/camera.ts';
import { ui } from '../state/ui.ts';
import { apply, rotation, type Vec } from './geometry.ts';
import { dragLinearEnd, linearAt, parseRadial, printRadial, radialAt } from './gradient-geom.ts';
import { computedBox, measure } from './measure.ts';
import { tickOverlay } from './overlay-tick.ts';

type GradientFill = Extract<Fill, { kind: 'linear' | 'radial' }>;

export function activeGradient(): { node: BogenNode; fills: Fill[]; fill: GradientFill; index: number; w: number; h: number } | null {
  const g = ui().gradient;
  if (!g) return null;
  const node = session().snap.nodes.get(g.nodeId);
  if (!node) return null;
  const fills = parseFills(node.style);
  const fill = fills[g.fillIndex];
  if (!fill || (fill.kind !== 'linear' && fill.kind !== 'radial')) return null;
  const box = computedBox(node.id);
  if (!box) return null;
  return { node, fills, fill, index: g.fillIndex, w: box.width, h: box.height };
}

/** A client position in the layer's own pixels, also when it is rotated. */
function toLocal(id: string, clientX: number, clientY: number): Vec | null {
  const m = measure(id);
  if (!m) return null;
  const w = camera.worldAt(clientX, clientY);
  const q = apply(rotation(-m.box.rot), { x: w.x - (m.box.x + m.box.w / 2), y: w.y - (m.box.y + m.box.h / 2) });
  return { x: q.x + m.box.w / 2, y: q.y + m.box.h / 2 };
}

function write(nodeId: string, fills: Fill[], index: number, fill: GradientFill): void {
  const s = session();
  const next = fills.map((f, i) => (i === index ? fill : f));
  s.tx(() => s.doc.updateStyle(nodeId, printFills(next)));
  tickOverlay();
}

const setStop = (stop: number) => {
  const g = ui().gradient;
  if (g && g.stop !== stop) ui().set({ gradient: { ...g, stop } });
};

/** Index a stop will have once the stops are written in order. */
function sortedIndex(stops: GradientStop[], stop: GradientStop): number {
  return [...stops].sort((a, b) => a.at - b.at).indexOf(stop);
}

interface DragHandlers { move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; cancel?: () => void }

/** A press on a gradient handle or on the gradient line. */
export function beginGradientDrag(e: PointerEvent, target: HTMLElement, startDrag: (e: PointerEvent, d: DragHandlers) => void): void {
  const a = activeGradient();
  if (!a) return;
  const s = session();
  const { node, fills, fill, index, w, h } = a;
  const role = target.dataset.gradient!;
  const stopIndex = target.dataset.gradientStop !== undefined ? Number(target.dataset.gradientStop) : -1;

  if (stopIndex >= 0 && e.altKey) {
    removeStop(stopIndex);
    return;
  }
  let stops = fill.stops;
  let active = stopIndex;
  if (role === 'line') {
    // A click on the line adds a stop there, which can then be dragged in the same gesture.
    const p = toLocal(node.id, e.clientX, e.clientY);
    if (!p) return;
    const at = Math.round(fill.kind === 'linear' ? linearAt(fill.angle, w, h, p) : radialAt(parseRadial(fill.shape, w, h), p));
    const added = interpolatedStop(stops, at);
    stops = [...stops, added];
    active = stops.length - 1;
    s.beginGesture();
    write(node.id, fills, index, { ...fill, stops });
    setStop(sortedIndex(stops, added));
  } else {
    s.beginGesture();
    if (active >= 0) setStop(active);
  }

  const ordered = [...stops].sort((x, y) => x.at - y.at);
  const isEnd = active >= 0 && (stops[active] === ordered[0] || stops[active] === ordered.at(-1));
  const startFill = { ...fill, stops };
  const startShape = fill.kind === 'radial' ? parseRadial(fill.shape, w, h) : null;
  let moved = false;

  startDrag(e, {
    move: (ev) => {
      const p = toLocal(node.id, ev.clientX, ev.clientY);
      if (!p) return;
      moved = true;
      if (startFill.kind === 'linear') {
        if (isEnd && role === 'stop') {
          const r = dragLinearEnd(startFill.angle, stops, w, h, active, p, ev.shiftKey ? 15 : 0);
          write(node.id, fills, index, { ...startFill, angle: r.angle, stops: r.stops });
          return;
        }
        const at = Math.round(linearAt(startFill.angle, w, h, p) * 10) / 10;
        const lo = Math.min(...stops.map((x) => x.at));
        const hi = Math.max(...stops.map((x) => x.at));
        const next = stops.map((x, i) => (i === active ? { ...x, at: Math.max(lo, Math.min(hi, at)) } : x));
        write(node.id, fills, index, { ...startFill, stops: next });
        setStop(sortedIndex(next, next[active]!));
        return;
      }
      const shape = startShape!;
      if (role === 'center') {
        write(node.id, fills, index, { ...startFill, shape: printRadial({ ...shape, cx: p.x, cy: p.y }, w, h) });
      } else if (role === 'radius') {
        const rx = Math.max(1, Math.abs(p.x - shape.cx));
        write(node.id, fills, index, { ...startFill, shape: printRadial({ ...shape, rx, ry: shape.kind === 'circle' ? rx : shape.ry }, w, h) });
      } else if (role === 'radius-y') {
        write(node.id, fills, index, { ...startFill, shape: printRadial({ ...shape, ry: Math.max(1, Math.abs(p.y - shape.cy)) }, w, h) });
      } else if (active >= 0) {
        const at = Math.round(radialAt(shape, p) * 10) / 10;
        const next = stops.map((x, i) => (i === active ? { ...x, at: Math.max(0, Math.min(100, at)) } : x));
        write(node.id, fills, index, { ...startFill, stops: next });
        setStop(sortedIndex(next, next[active]!));
      }
    },
    up: () => {
      s.endGesture();
      void moved;
    },
    cancel: () => {
      s.endGesture();
      s.undo.undo();
      s.undo.redoStack.pop();
    },
  });
}

export function removeStop(index: number): void {
  const a = activeGradient();
  if (!a || a.fill.stops.length <= 2 || index < 0 || index >= a.fill.stops.length) return;
  const stops = a.fill.stops.filter((_, i) => i !== index);
  write(a.node.id, a.fills, a.index, { ...a.fill, stops });
  setStop(Math.max(0, index - 1));
}

/** Delete on the active stop while handles are out. Returns whether the key was used. */
export function gradientKey(e: KeyboardEvent): boolean {
  const g = ui().gradient;
  if (!g || (e.key !== 'Delete' && e.key !== 'Backspace')) return false;
  const a = activeGradient();
  if (!a || a.fill.stops.length <= 2) return Boolean(a);
  removeStop(g.stop);
  return true;
}
