import { apply, hasLinear, IDENTITY, invert, linearOf, matRotation, multiply, type LocalBox, type Mat2, type Rect, type Vec } from './geometry.ts';
import { camera } from '../state/camera.ts';
import { session } from '../doc/session.ts';
import { tickOverlay } from './overlay-tick.ts';

const registry = new Map<string, HTMLElement>();
let worldEl: HTMLElement | null = null;

export function setWorldEl(el: HTMLElement | null): void {
  worldEl = el;
}

export function registerEl(id: string, el: HTMLElement | null): void {
  if (el) {
    registry.set(id, el);
    // Overlay items anchored to this layer could not measure it during the render that created it.
    tickOverlay();
  } else registry.delete(id);
}

export function elOf(id: string): HTMLElement | undefined {
  return registry.get(id);
}

export interface Measured {
  id: string;
  /** Axis aligned bounds in world coordinates. */
  rect: Rect;
  /** Oriented box in world coordinates. */
  box: LocalBox;
}

/** Linear transform from the world down to and including a layer, from the snapshot. */
export function cumulativeLinear(id: string): Mat2 {
  const { snap } = session();
  let m = IDENTITY;
  const chain: string[] = [id, ...snap.ancestors(id)];
  for (const a of chain.reverse()) {
    const n = snap.nodes.get(a);
    if (n && hasLinear(n.style)) m = multiply(m, linearOf(n.style));
  }
  return m;
}

export function parentLinear(id: string): Mat2 {
  const { snap } = session();
  const n = snap.nodes.get(id);
  if (!n || !snap.nodes.has(n.parent)) return IDENTITY;
  return cumulativeLinear(n.parent);
}

function isTransformed(id: string): boolean {
  const { snap } = session();
  let cur = snap.nodes.get(id);
  while (cur) {
    if (hasLinear(cur.style)) return true;
    cur = snap.nodes.get(cur.parent);
  }
  return false;
}

export function worldRectOfClient(r: DOMRect | { left: number; top: number; width: number; height: number }): Rect {
  const z = camera.value.z;
  const origin = worldEl?.getBoundingClientRect();
  const ox = origin?.left ?? 0;
  const oy = origin?.top ?? 0;
  return { x: (r.left - ox) / z, y: (r.top - oy) / z, w: r.width / z, h: r.height / z };
}

export function measure(id: string): Measured | null {
  const el = registry.get(id);
  if (!el) return null;
  const rect = worldRectOfClient(el.getBoundingClientRect());
  if (!isTransformed(id)) return { id, rect, box: { ...rect, rot: 0 } };
  const cs = getComputedStyle(el);
  let w = parseFloat(cs.width);
  let h = parseFloat(cs.height);
  if (Number.isNaN(w)) w = el.offsetWidth;
  if (Number.isNaN(h)) h = el.offsetHeight;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  return { id, rect, box: { x: cx - w / 2, y: cy - h / 2, w, h, rot: matRotation(cumulativeLinear(id)) } };
}

/** As `measure`, with the box the size it has on screen, for what is drawn around a scaled layer. */
export function measureOnScreen(id: string): Measured | null {
  const m = measure(id);
  if (!m || (m.box.w === m.rect.w && m.box.h === m.rect.h && !m.box.rot)) return m;
  const linear = cumulativeLinear(id);
  const sx = Math.hypot(linear.a, linear.b);
  const sy = Math.hypot(linear.c, linear.d);
  if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) return m;
  const w = m.box.w * sx;
  const h = m.box.h * sy;
  const cx = m.rect.x + m.rect.w / 2;
  const cy = m.rect.y + m.rect.h / 2;
  return { ...m, box: { x: cx - w / 2, y: cy - h / 2, w, h, rot: m.box.rot } };
}

export function rectOf(id: string): Rect | null {
  const el = registry.get(id);
  return el ? worldRectOfClient(el.getBoundingClientRect()) : null;
}

/** Layout position and size as the browser resolved them. */
export function computedBox(id: string): { left: number; top: number; width: number; height: number; position: string } | null {
  const el = registry.get(id);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const pf = (v: string, fallback: number) => {
    const n = parseFloat(v);
    return Number.isNaN(n) ? fallback : n;
  };
  return { left: pf(cs.left, el.offsetLeft), top: pf(cs.top, el.offsetTop), width: pf(cs.width, el.offsetWidth), height: pf(cs.height, el.offsetHeight), position: cs.position };
}

/** A world point in the coordinates absolute children of `parent` are positioned in. */
export function toParentLocal(parent: string, p: Vec): Vec {
  const { snap } = session();
  if (!snap.nodes.has(parent)) return p;
  const el = registry.get(parent);
  if (!el) return p;
  const m = measure(parent);
  if (!m) return p;
  const cx = m.box.x + m.box.w / 2;
  const cy = m.box.y + m.box.h / 2;
  const q = apply(invert(cumulativeLinear(parent)), { x: p.x - cx, y: p.y - cy });
  return { x: q.x + m.box.w / 2 - el.clientLeft, y: q.y + m.box.h / 2 - el.clientTop };
}

/** The inverse direction, for drawing things at a child's coordinates. */
export function fromParentLocal(parent: string, p: Vec): Vec {
  const { snap } = session();
  if (!snap.nodes.has(parent)) return p;
  const el = registry.get(parent);
  const m = measure(parent);
  if (!el || !m) return p;
  const cx = m.box.x + m.box.w / 2;
  const cy = m.box.y + m.box.h / 2;
  const q = apply(cumulativeLinear(parent), { x: p.x + el.clientLeft - m.box.w / 2, y: p.y + el.clientTop - m.box.h / 2 });
  return { x: q.x + cx, y: q.y + cy };
}

/** Whether a layer follows the flow of its parent, as opposed to being positioned in it. */
export function isFlow(id: string): boolean {
  const { snap } = session();
  const n = snap.nodes.get(id);
  if (!n) return false;
  if (!snap.nodes.has(n.parent)) return false;
  const p = n.style.position;
  return p !== 'absolute' && p !== 'fixed';
}

export type FlowKind = { kind: 'none' } | { kind: 'flow'; axis: 'x' | 'y'; wrap: boolean; reverse: boolean; grid: boolean };

/** How a frame lays out its children. Reads the DOM, so CSS from classes counts as well. */
export function flowOf(id: string): FlowKind {
  const { snap } = session();
  const n = snap.nodes.get(id);
  if (!n) return { kind: 'none' };
  const el = registry.get(id);
  const display = el ? getComputedStyle(el).display : (n.style.display ?? 'block');
  if (display === 'flex' || display === 'inline-flex') {
    const dir = n.style.flexDirection ?? 'row';
    return { kind: 'flow', axis: dir.startsWith('column') ? 'y' : 'x', wrap: (n.style.flexWrap ?? 'nowrap') !== 'nowrap', reverse: dir.endsWith('reverse'), grid: false };
  }
  if (display === 'grid' || display === 'inline-grid') return { kind: 'flow', axis: 'x', wrap: true, reverse: false, grid: true };
  return { kind: 'none' };
}

export function hasFlowChildren(id: string): boolean {
  const { snap } = session();
  return snap.children(id).some((c) => isFlow(c));
}

/** Elements found at a client position, deepest first, as layer ids. */
export function idsAtPoint(clientX: number, clientY: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const host = (el as HTMLElement).closest?.('[data-bogen-id]');
    const id = host?.getAttribute('data-bogen-id');
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
