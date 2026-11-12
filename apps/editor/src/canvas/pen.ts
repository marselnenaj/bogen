import { create } from 'zustand';
import { session } from '../doc/session.ts';
import { apply, rotation, type Vec } from './geometry.ts';
import { measure, parentLinear } from './measure.ts';
import { boundsOf, nearestOnPath, parseD, pathToD, splitSegment, translatePaths, type PathPoint, type SubPath } from './path.ts';
import { computedBox } from './measure.ts';
import { fmt, fmtPx } from '../lib/css-values.ts';
import { invert } from './geometry.ts';
import { createPathLayer, pageId } from '../ops/ops.ts';
import { editor } from '../state/store.ts';
import { t } from '../i18n/store.ts';

/** The pen tool's unfinished path, in world coordinates. */
interface PenState {
  points: PathPoint[];
  hover: Vec | null;
  closingHover: boolean;
  set: (patch: Partial<PenState>) => void;
}

export const usePen = create<PenState>((set) => ({
  points: [],
  hover: null,
  closingHover: false,
  set: (patch) => set(patch),
}));

export function penActive(): boolean {
  return usePen.getState().points.length > 0;
}

export function finishPen(close = false): void {
  const { points, set } = usePen.getState();
  set({ points: [], hover: null, closingHover: false });
  if (points.length < 2) {
    editor().set({ tool: 'move' });
    return;
  }
  const id = createPathLayer([{ points, closed: close }], pageId());
  editor().set({ selection: [id], tool: 'move' });
}

export function cancelPen(): void {
  usePen.getState().set({ points: [], hover: null, closingHover: false });
}

// Node editing of existing vectors

export interface PathEdit {
  id: string;
  /** Each `<path>` of the markup, in the layer's pixel coordinates. */
  paths: SubPath[][];
  selected: { path: number; sub: number; point: number } | null;
}

interface PathEditStore {
  edit: PathEdit | null;
  set: (edit: PathEdit | null) => void;
}

export const usePathEdit = create<PathEditStore>((set) => ({ edit: null, set: (edit) => set({ edit }) }));

function parseMarkup(svg: string): { doc: Document; root: Element; els: Element[]; vb: number[] } | null {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg') return null;
  // Paths in `defs` are arrow heads and the like, not part of the drawing.
  const els = [...root.querySelectorAll('path')].filter((el) => !el.closest('defs'));
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(parseFloat);
  return { doc, root, els, vb };
}

function scalePaths(paths: SubPath[], sx: number, sy: number, dx: number, dy: number): SubPath[] {
  return paths.map((s) => ({
    closed: s.closed,
    points: s.points.map((p) => ({
      x: (p.x + dx) * sx, y: (p.y + dy) * sy,
      ...(p.hx1 !== undefined ? { hx1: (p.hx1 + dx) * sx, hy1: (p.hy1! + dy) * sy } : {}),
      ...(p.hx2 !== undefined ? { hx2: (p.hx2 + dx) * sx, hy2: (p.hy2! + dy) * sy } : {}),
    })),
  }));
}

export function startPathEdit(id: string): boolean {
  const { snap } = session();
  const n = snap.nodes.get(id);
  const m = measure(id);
  if (!n?.svg || !m) return false;
  const parsed = parseMarkup(n.svg);
  if (!parsed || !parsed.els.length) {
    editor().showToast(t('This vector has no paths to edit.'));
    return false;
  }
  const vbW = parsed.vb[2] || m.box.w || 1;
  const vbH = parsed.vb[3] || m.box.h || 1;
  const sx = m.box.w / vbW;
  const sy = m.box.h / vbH;
  const dx = -(parsed.vb[0] || 0);
  const dy = -(parsed.vb[1] || 0);
  const paths = parsed.els.map((el) => scalePaths(parseD(el.getAttribute('d') ?? ''), sx, sy, dx, dy));
  usePathEdit.getState().set({ id, paths, selected: null });
  editor().set({ editingPathId: id, selection: [id] });
  return true;
}

/** Live preview during a drag, without touching the document. */
export function previewPathEdit(edit: PathEdit): void {
  const { snap } = session();
  const n = snap.nodes.get(edit.id);
  if (!n?.svg) return;
  const m = measure(edit.id);
  const host = document.querySelector(`[data-bogen-id="${edit.id}"]`);
  if (!host || !m) return;
  const svg = host.querySelector('svg');
  if (!svg) return;
  svg.setAttribute('viewBox', `0 0 ${fmt(m.box.w)} ${fmt(m.box.h)}`);
  [...svg.querySelectorAll('path')].filter((el) => !el.closest('defs')).forEach((el, i) => {
    const subs = edit.paths[i];
    if (subs) el.setAttribute('d', pathToD(subs));
  });
}

/** Writes the edited paths back and refits the layer to their new bounds. */
export function commitPathEdit(edit: PathEdit): void {
  const s = session();
  const n = s.snap.nodes.get(edit.id);
  if (!n?.svg) return;
  const parsed = parseMarkup(n.svg);
  const m = measure(edit.id);
  const box = computedBox(edit.id);
  if (!parsed || !m || !box) return;
  const all = edit.paths.flat();
  const b = boundsOf(all);
  const w = Math.max(b.w, 1);
  const h = Math.max(b.h, 1);
  const moved = edit.paths.map((p) => translatePaths(p, -b.x, -b.y));
  parsed.els.forEach((el, i) => el.setAttribute('d', pathToD(moved[i] ?? [])));
  parsed.root.setAttribute('viewBox', `0 0 ${fmt(w)} ${fmt(h)}`);
  parsed.root.setAttribute('width', '100%');
  parsed.root.setAttribute('height', '100%');
  parsed.root.setAttribute('preserveAspectRatio', 'none');
  // Rotation is about the centre, so a changed box moves the centre along the rotated axes.
  const r = rotation(m.box.rot);
  const shift = apply(r, { x: b.x + w / 2 - box.width / 2, y: b.y + h / 2 - box.height / 2 });
  const inv = invert(parentLinear(edit.id));
  const local = apply(inv, shift);
  const left = box.left + box.width / 2 + local.x - w / 2;
  const top = box.top + box.height / 2 + local.y - h / 2;
  const markup = new XMLSerializer().serializeToString(parsed.root);
  s.tx(() => {
    s.doc.updateFields(edit.id, { svg: markup });
    s.doc.updateStyle(edit.id, { left: fmtPx(left), top: fmtPx(top), width: fmtPx(w), height: fmtPx(h) });
  });
  usePathEdit.getState().set({ ...edit, paths: moved });
}

export function endPathEdit(): void {
  usePathEdit.getState().set(null);
  editor().set({ editingPathId: null });
}

export function deleteSelectedPoint(): void {
  const edit = usePathEdit.getState().edit;
  if (!edit?.selected) return;
  const { path, sub, point } = edit.selected;
  const subs = edit.paths[path]!;
  const target = subs[sub]!;
  const points = target.points.filter((_, i) => i !== point);
  const next = { ...edit, selected: null, paths: edit.paths.map((p, pi) => (pi === path ? p.map((q, si) => (si === sub ? { ...q, points } : q)) : p)) };
  if (points.length < 2) {
    next.paths[path] = subs.filter((_, si) => si !== sub);
  }
  if (!next.paths.flat().length) {
    const s = session();
    s.tx(() => s.doc.delete([edit.id]));
    endPathEdit();
    editor().set({ selection: [] });
    return;
  }
  commitPathEdit(next);
}

/** Turns a node between sharp and smooth. */
export function togglePointSmooth(path: number, sub: number, point: number): void {
  const edit = usePathEdit.getState().edit;
  if (!edit) return;
  const subs = edit.paths[path]!;
  const pts = subs[sub]!.points;
  const p = pts[point]!;
  const n = pts.length;
  const closed = subs[sub]!.closed;
  const prev = pts[point - 1] ?? (closed ? pts[n - 1] : undefined);
  const next = pts[point + 1] ?? (closed ? pts[0] : undefined);
  let np: PathPoint;
  if (p.hx1 !== undefined || p.hx2 !== undefined) np = { x: p.x, y: p.y };
  else {
    const ax = prev?.x ?? p.x;
    const ay = prev?.y ?? p.y;
    const bx = next?.x ?? p.x;
    const by = next?.y ?? p.y;
    const dx = (bx - ax) / 4;
    const dy = (by - ay) / 4;
    np = { x: p.x, y: p.y, hx1: p.x - dx, hy1: p.y - dy, hx2: p.x + dx, hy2: p.y + dy };
  }
  const nextPts = pts.map((q, i) => (i === point ? np : q));
  commitPathEdit({ ...edit, paths: edit.paths.map((pp, pi) => (pi === path ? pp.map((q, si) => (si === sub ? { ...q, points: nextPts } : q)) : pp)) });
}

/** Adds a node on a segment when clicked near one. Coordinates are local to the layer. */
export function insertPointNear(local: Vec, tolerance: number): boolean {
  const edit = usePathEdit.getState().edit;
  if (!edit) return false;
  for (let pi = 0; pi < edit.paths.length; pi++) {
    const found = nearestOnPath(edit.paths[pi]!, local);
    if (!found || found.dist > tolerance) continue;
    const sub = edit.paths[pi]![found.sub]!;
    const n = sub.points.length;
    const a = sub.points[found.seg]!;
    const b = sub.points[(found.seg + 1) % n]!;
    const split = splitSegment(a, b, found.t);
    const pts = [...sub.points];
    pts[found.seg] = split.a;
    pts[(found.seg + 1) % n] = split.b;
    pts.splice(found.seg + 1, 0, split.mid);
    const paths = edit.paths.map((pp, x) => (x === pi ? pp.map((q, si) => (si === found.sub ? { ...q, points: pts } : q)) : pp));
    commitPathEdit({ ...edit, paths, selected: null });
    return true;
  }
  return false;
}

export { pageId };
