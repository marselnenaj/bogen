import { readCanvasPlan, insertTarget, isVirtualId, type BogenNode, type NewNode } from '@bogen/core';
import { fitScreen } from './fit-view.ts';
import { flushSync } from 'react-dom';
import { alignDeltas, apply, distributeDeltas, invert, linearOf, matRotation, spaceDeltas, spacingOf, unionRects, type AlignKind, type Rect, type Vec } from '../canvas/geometry.ts';
import { computedBox, cumulativeLinear, elOf, flowOf, isFlow, measure, parentLinear, rectOf, toParentLocal } from '../canvas/measure.ts';
import { pathToD, type SubPath, boundsOf, translatePaths } from '../canvas/path.ts';
import { session } from '../doc/session.ts';
import { camera } from '../state/camera.ts';
import { editor } from '../state/store.ts';
import { fmt, fmtPx, px } from '../lib/css-values.ts';
import { positionPatch } from '../lib/constraints.ts';
import { settings } from '../state/settings.ts';
import { t } from '../i18n/store.ts';

export const POSITION_KEYS = ['position', 'left', 'top', 'right', 'bottom'] as const;
export const SIZE_KEYS = ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf'] as const;

export function pageId(): string {
  const id = editor().pageId;
  if (!id) throw new Error(t('No page is open.'));
  return id;
}

export function setStyle(ids: string[], patch: Record<string, string | null>): void {
  const s = session();
  s.tx(() => {
    for (const id of ids) if (s.snap.nodes.has(id)) s.doc.updateStyle(id, patch);
  });
}

export function setFields(ids: string[], patch: Parameters<ReturnType<typeof session>['doc']['updateFields']>[1]): void {
  const s = session();
  s.tx(() => {
    for (const id of ids) if (s.snap.nodes.has(id)) s.doc.updateFields(id, patch);
  });
}

/** Frames that can take children when something is dropped or drawn into them. */
export function isContainer(n: BogenNode): boolean {
  if (n.type !== 'frame') return false;
  // Inside an instance only slots can. An instance itself can when it has a slot to put them in.
  if (n.instanceOf !== undefined) {
    try {
      insertTarget(session().snap.source, n.id);
      return true;
    } catch {
      return false;
    }
  }
  if (n.virtual && n.slotName === undefined) return false;
  if (VOID_TAGS.has(n.tag)) return false;
  return true;
}

export const VOID_TAGS = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'textarea', 'select', 'progress', 'meter']);

/** Childless rectangles and ellipses read as shapes; dragging past one should not nest into it. */
export function isDropTarget(n: BogenNode): boolean {
  if (!isContainer(n)) return false;
  if (n.artboard) return true;
  const { snap } = session();
  if (snap.children(n.id).length) return true;
  if (n.style.display === 'flex' || n.style.display === 'grid') return true;
  return !/^(Rectangle|Ellipse|Line)\b/.test(n.name);
}

/** Selection without layers whose ancestor is also selected, and without locked layers. */
export function topLevelOf(ids: string[], includeLocked = false): string[] {
  const { snap } = session();
  const set = new Set(ids);
  return ids.filter((id) => snap.nodes.has(id) && !snap.ancestors(id).some((a) => set.has(a)) && (includeLocked || !snap.isLocked(id)));
}

/** Ids in document order, painted first to painted last. */
export function inTreeOrder(ids: string[]): string[] {
  const { snap } = session();
  const keyOf = (id: string): number[] => {
    const chain = [id, ...snap.ancestors(id)].reverse();
    return chain.map((c) => {
      const n = snap.nodes.get(c);
      return n ? snap.children(n.parent).indexOf(c) : 0;
    });
  };
  const keys = new Map(ids.map((id) => [id, keyOf(id)]));
  return [...ids].sort((a, b) => {
    const ka = keys.get(a)!;
    const kb = keys.get(b)!;
    for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    return ka.length - kb.length;
  });
}

/** Makes sure absolute children of a frame resolve against it. */
export function ensurePositioned(parent: string): void {
  const s = session();
  const n = s.snap.nodes.get(parent);
  if (!n) return;
  const box = computedBox(parent);
  if (box?.position === 'static' || (!box && !n.style.position)) s.doc.updateStyle(parent, { position: 'relative' });
}

/**
 * Style to place a layer at a world position under a new parent. Keeps it visually where it is,
 * also when the parents are rotated differently.
 */
export function placement(id: string, parent: string, centreWorld?: Vec): Record<string, string | null> {
  const m = measure(id);
  const { snap } = session();
  const n = snap.nodes.get(id)!;
  if (!m) return {};
  const cx = centreWorld?.x ?? m.box.x + m.box.w / 2;
  const cy = centreWorld?.y ?? m.box.y + m.box.h / 2;
  const c = toParentLocal(parent, { x: cx, y: cy });
  const patch: Record<string, string | null> = {
    position: 'absolute',
    left: fmtPx(c.x - m.box.w / 2),
    top: fmtPx(c.y - m.box.h / 2),
    right: null,
    bottom: null,
    width: fmtPx(m.box.w),
    height: n.type === 'text' && !n.style.height ? null : fmtPx(m.box.h),
  };
  const oldParent = matRotation(parentLinear(id));
  const nextParent = snap.nodes.has(parent) ? matRotation(cumulativeLinear(parent)) : 0;
  if (Math.abs(oldParent - nextParent) > 0.01) {
    const own = matRotation(linearOf({ rotate: n.style.rotate }));
    patch.rotate = `${fmt(own + oldParent - nextParent)}deg`;
  }
  return patch;
}

/** Style that makes a layer a flow child, what it has to give up to follow layout. */
export const FLOW_PATCH: Record<string, string | null> = { position: null, left: null, top: null, right: null, bottom: null };

export function selectAndMove(ids: string[]): void {
  editor().set({ selection: ids, tool: 'move' });
}

export function deleteSelection(): void {
  const s = session();
  const ids = topLevelOf(editor().selection);
  if (!ids.length) return;
  const parents = new Set(ids.map((id) => s.snap.nodes.get(id)!.parent));
  s.tx(() => s.doc.delete(ids));
  const parent = [...parents][0]!;
  editor().set({ selection: parents.size === 1 && s.snap.nodes.has(parent) ? [parent] : [], hoverId: null });
}

export function duplicateSelection(offset = true): string[] {
  const s = session();
  const ids = topLevelOf(editor().selection);
  if (!ids.length) return [];
  let out: string[] = [];
  flushSync(() => {
    s.tx(() => {
      out = s.doc.duplicate(ids);
      if (offset) {
        for (const id of out) {
          const n = s.doc.getNode(id);
          if (n && n.style.position === 'absolute' && n.style.left && n.style.top) {
            s.doc.updateStyle(id, { left: fmtPx(px(n.style.left) + 16), top: fmtPx(px(n.style.top) + 16) });
          }
        }
      }
    });
  });
  editor().set({ selection: out });
  return out;
}

export function selectAll(): void {
  const { snap } = session();
  const sel = editor().selection;
  const parent = sel.length ? snap.nodes.get(sel[0]!)?.parent ?? pageId() : pageId();
  editor().set({ selection: snap.children(parent).filter((id) => !snap.nodes.get(id)?.locked && !snap.nodes.get(id)?.hidden) as string[] });
}

export function selectParent(): void {
  const { snap } = session();
  const first = editor().selection[0];
  if (!first) return;
  const p = snap.nodes.get(first)?.parent;
  if (p && snap.nodes.has(p)) editor().set({ selection: [p] });
}

export function selectChild(): void {
  const { snap } = session();
  const sel = editor().selection;
  const out = sel.flatMap((id) => {
    const kids = snap.children(id);
    return kids.length ? [kids.at(-1)!] : [];
  });
  if (out.length) editor().set({ selection: out });
}

export function selectSibling(direction: 1 | -1): void {
  const { snap } = session();
  const first = editor().selection.at(direction > 0 ? -1 : 0);
  if (!first) {
    const top = snap.children(pageId());
    if (top.length) editor().set({ selection: [top.at(-1)!] });
    return;
  }
  const n = snap.nodes.get(first);
  if (!n) return;
  const sibs = snap.children(n.parent);
  const i = sibs.indexOf(first);
  const next = sibs[(i + direction + sibs.length) % sibs.length];
  if (next) editor().set({ selection: [next] });
}

function positionedItems(ids: string[]): { id: string; rect: Rect }[] {
  return ids.flatMap((id) => {
    const rect = rectOf(id);
    return rect ? [{ id, rect }] : [];
  });
}

function moveBy(id: string, delta: Vec): void {
  const s = session();
  if (!delta.x && !delta.y) return;
  const n = s.snap.nodes.get(id);
  const box = computedBox(id);
  if (!n || !box || isFlow(id)) return;
  const local = apply(invert(parentLinear(id)), delta);
  s.doc.updateStyle(id, positionPatchOf(id, box.left + local.x, box.top + local.y));
}

/** A layer at new coordinates in its parent, keeping what it is constrained to. */
export function positionPatchOf(id: string, x: number, y: number): Record<string, string | null> {
  const s = session();
  const n = s.snap.nodes.get(id);
  const box = computedBox(id);
  if (!n || !box) return { left: fmtPx(x), top: fmtPx(y), right: null, bottom: null };
  const parent = elOf(n.parent);
  return positionPatch(n.style, x, y, box.width, box.height, parent?.clientWidth ?? 0, parent?.clientHeight ?? 0);
}

export function align(kind: AlignKind): void {
  const s = session();
  const sel = topLevelOf(editor().selection);
  const items = positionedItems(sel);
  if (!items.length) return;
  let to: Rect | undefined;
  if (items.length === 1) {
    const parent = s.snap.nodes.get(items[0]!.id)?.parent;
    const pr = parent ? rectOf(parent) : null;
    if (!pr) return;
    to = pr;
  }
  const deltas = alignDeltas(items.map((i) => i.rect), kind, to);
  s.tx(() => items.forEach((it, i) => moveBy(it.id, deltas[i]!)));
}

export function distribute(axis: 'x' | 'y'): void {
  const s = session();
  const items = positionedItems(topLevelOf(editor().selection));
  if (items.length < 3) return;
  const deltas = distributeDeltas(items.map((i) => i.rect), axis);
  s.tx(() => items.forEach((it, i) => moveBy(it.id, deltas[i]!)));
}

/**
 * The spacing of the selected layers along an axis: the gap when it is the same everywhere, MIXED-like null
 * when it differs, or undefined when they are not side by side or follow a layout.
 */
export function spacingInfo(ids: readonly string[], axis: 'x' | 'y'): { gap: number | null; ids: string[]; rects: Rect[]; order: number[]; gaps: number[] } | undefined {
  // Measured on every frame while shown: a select-all of a big page is not a row of cards.
  if (ids.length < 2 || ids.length > 300) return undefined;
  const items = positionedItems(topLevelOf([...ids]));
  if (items.length < 2 || items.some((it) => isFlow(it.id))) return undefined;
  const rects = items.map((i) => i.rect);
  const s = spacingOf(rects, axis);
  if (!s) return undefined;
  const first = s.gaps[0]!;
  const same = s.gaps.every((g) => Math.abs(g - first) < 0.5);
  return { gap: same ? Math.round(first * 100) / 100 : null, ids: items.map((i) => i.id), rects, order: s.order, gaps: s.gaps };
}

/** Leaves `gap` between the selected layers along an axis, the first staying where it is. One undo step, or part of a gesture. */
export function setSpacing(axis: 'x' | 'y', gap: number, ids: readonly string[] = editor().selection): void {
  const info = spacingInfo(ids, axis);
  if (!info) return;
  const deltas = spaceDeltas(info.rects, axis, Math.max(0, gap));
  const s = session();
  s.tx(() => info.ids.forEach((id, i) => moveBy(id, deltas[i]!)));
}

/** Arranges the selection in rows and columns with even gaps, keeping reading order. */
export function tidy(): void {
  const s = session();
  const items = positionedItems(topLevelOf(editor().selection));
  if (items.length < 2) return;
  const sorted = [...items].sort((a, b) => a.rect.y - b.rect.y);
  const rows: (typeof items)[] = [];
  for (const it of sorted) {
    const row = rows.at(-1);
    const avgBottom = row ? Math.max(...row.map((r) => r.rect.y + r.rect.h)) : -Infinity;
    if (row && it.rect.y < avgBottom) row.push(it);
    else rows.push([it]);
  }
  rows.forEach((r) => r.sort((a, b) => a.rect.x - b.rect.x));
  const group = unionRects(items.map((i) => i.rect))!;
  const gapsX = rows.flatMap((r) => r.slice(1).map((it, i) => it.rect.x - (r[i]!.rect.x + r[i]!.rect.w)));
  const gapX = gapsX.length ? Math.max(0, Math.round(gapsX.reduce((a, b) => a + b, 0) / gapsX.length)) : 16;
  const rowGaps = rows.slice(1).map((r, i) => Math.min(...r.map((x) => x.rect.y)) - Math.max(...rows[i]!.map((x) => x.rect.y + x.rect.h)));
  const gapY = rowGaps.length ? Math.max(0, Math.round(rowGaps.reduce((a, b) => a + b, 0) / rowGaps.length)) : 16;
  s.tx(() => {
    let y = group.y;
    for (const row of rows) {
      let x = group.x;
      let h = 0;
      for (const it of row) {
        moveBy(it.id, { x: x - it.rect.x, y: y - it.rect.y });
        x += it.rect.w + gapX;
        h = Math.max(h, it.rect.h);
      }
      y += h + gapY;
    }
  });
}

export type ZMove = 'forward' | 'backward' | 'front' | 'back';

export function zOrder(move: ZMove): void {
  const s = session();
  const ids = inTreeOrder(topLevelOf(editor().selection)).filter((id) => !isVirtualId(id));
  const byParent = new Map<string, string[]>();
  for (const id of ids) {
    const p = s.snap.nodes.get(id)!.parent;
    byParent.set(p, [...(byParent.get(p) ?? []), id]);
  }
  s.tx(() => {
    for (const [parent, list] of byParent) {
      const sibs = s.snap.children(parent);
      if (move === 'front') s.doc.move(list, parent, sibs.length);
      else if (move === 'back') s.doc.move(list, parent, 0);
      else if (move === 'forward') {
        const last = sibs.indexOf(list.at(-1)!);
        s.doc.move(list, parent, Math.min(sibs.length, last + 2));
      } else {
        const first = sibs.indexOf(list[0]!);
        s.doc.move(list, parent, Math.max(0, first - 1));
      }
    }
  });
}

export function toggleLock(): void {
  const s = session();
  const nodes = editor().selection.flatMap((id) => s.snap.nodes.get(id) ?? []);
  if (!nodes.length) return;
  const lock = nodes.some((n) => !n.locked);
  s.tx(() => nodes.forEach((n) => s.doc.updateFields(n.id, { locked: lock ? true : undefined })));
  if (lock) editor().set({ selection: [] });
}

export function toggleHide(): void {
  const s = session();
  const nodes = editor().selection.flatMap((id) => s.snap.nodes.get(id) ?? []);
  if (!nodes.length) return;
  const hide = nodes.some((n) => !n.hidden);
  s.tx(() => nodes.forEach((n) => s.doc.updateFields(n.id, { hidden: hide ? true : undefined })));
}

/** Mirrors each layer in place, and with several also their positions in the group. */
export function flip(axis: 'x' | 'y'): void {
  const s = session();
  const ids = topLevelOf(editor().selection);
  const items = positionedItems(ids);
  if (!items.length) return;
  const group = unionRects(items.map((i) => i.rect))!;
  s.tx(() => {
    for (const it of items) {
      const n = s.snap.nodes.get(it.id)!;
      const parts = (n.style.scale && n.style.scale !== 'none' ? n.style.scale : '1 1').trim().split(/\s+/).map(parseFloat);
      const sx = parts[0] ?? 1;
      const sy = parts[1] ?? sx;
      const nx = axis === 'x' ? -sx : sx;
      const ny = axis === 'y' ? -sy : sy;
      s.doc.updateStyle(it.id, { scale: nx === 1 && ny === 1 ? null : `${nx} ${ny}` });
      if (items.length > 1) {
        const dx = axis === 'x' ? group.x + group.x + group.w - 2 * it.rect.x - it.rect.w : 0;
        const dy = axis === 'y' ? group.y + group.y + group.h - 2 * it.rect.y - it.rect.h : 0;
        moveBy(it.id, { x: dx, y: dy });
      }
    }
  });
}

export function nudge(stepX: number, stepY: number): void {
  // The commands say 1 or 10; how far that is, is up to the person.
  const prefs = settings();
  const unit = Math.abs(stepX || stepY) >= 10 ? prefs.nudgeBig / 10 : prefs.nudgeSmall;
  const dx = stepX * unit;
  const dy = stepY * unit;
  const s = session();
  const ids = topLevelOf(editor().selection);
  if (!ids.length) return;
  s.tx(() => {
    for (const id of ids) {
      if (!isFlow(id)) {
        moveBy(id, { x: dx, y: dy });
        continue;
      }
      if (isVirtualId(id)) continue;
      const n = s.snap.nodes.get(id)!;
      const flow = flowOf(n.parent);
      const horizontal = flow.kind === 'flow' ? flow.axis === 'x' : false;
      const step = horizontal ? Math.sign(dx) : Math.sign(dy);
      if (!step) continue;
      const sibs = s.snap.children(n.parent);
      const i = sibs.indexOf(id);
      const j = i + step;
      if (j < 0 || j >= sibs.length) continue;
      s.doc.move([id], n.parent, step > 0 ? j + 1 : j);
    }
  });
}

interface WrapOptions { name: string; style?: Record<string, string>; flex?: boolean }

/** Puts layers in a new frame that exactly fits them, without moving anything on screen. */
function wrap(ids: string[], options: WrapOptions): string | null {
  const s = session();
  const { snap, doc } = s;
  const top = inTreeOrder(topLevelOf(ids)).filter((id) => !isVirtualId(id));
  if (!top.length) return null;
  const parent = snap.nodes.get(top[0]!)!.parent;
  const measured = top.flatMap((id) => measure(id) ?? []);
  const bounds = unionRects(measured.map((m) => m.rect));
  if (!bounds) return null;
  const index = snap.children(parent).indexOf(top.at(-1)!) + 1;
  const flowParent = isFlow(top[0]!);
  const local = toParentLocal(parent, { x: bounds.x, y: bounds.y });
  const size = { width: fmtPx(bounds.w), height: fmtPx(bounds.h) };
  const frameStyle: Record<string, string> = flowParent
    ? { position: 'relative', ...size, ...options.style }
    : { position: 'absolute', left: fmtPx(local.x), top: fmtPx(local.y), ...size, ...options.style };
  let id = '';
  const placed = new Map<string, Record<string, string | null>>();
  for (const m of measured) {
    const c = { x: m.box.x + m.box.w / 2 - bounds.x, y: m.box.y + m.box.h / 2 - bounds.y };
    const n = snap.nodes.get(m.id)!;
    placed.set(m.id, options.flex ? FLOW_PATCH : {
      position: 'absolute',
      left: fmtPx(c.x - m.box.w / 2),
      top: fmtPx(c.y - m.box.h / 2),
      right: null,
      bottom: null,
      width: fmtPx(m.box.w),
      height: n.type === 'text' && !n.style.height ? null : fmtPx(m.box.h),
    });
  }
  flushSync(() => {
    s.tx(() => {
      id = doc.insert(parent, { type: 'frame', name: options.name, style: frameStyle }, index);
      for (const m of measured) doc.updateStyle(m.id, placed.get(m.id)!);
      doc.move(top, id);
    });
  });
  return id;
}

/** For making a component from several layers. */
export const wrapIn = wrap;

export function groupSelection(): void {
  const id = wrap(editor().selection, { name: 'Group' });
  if (id) editor().set({ selection: [id] });
}

export function wrapInFrame(): void {
  const id = wrap(editor().selection, { name: 'Frame' });
  if (id) editor().set({ selection: [id] });
}

/** Adds flex layout: to a frame directly, or around several layers in reading order. */
export function addAutoLayout(): void {
  const s = session();
  const { snap } = s;
  const sel = topLevelOf(editor().selection).filter((id) => !isVirtualId(id) && snap.nodes.get(id)?.instanceOf === undefined);
  if (!sel.length) return;
  if (sel.length === 1 && snap.nodes.get(sel[0]!)?.type === 'frame') {
    s.tx(() => {
      const kids = snap.children(sel[0]!);
      s.doc.updateStyle(sel[0]!, { display: 'flex', flexDirection: 'row', gap: '8px', alignItems: 'flex-start', ...(kids.length ? { width: 'fit-content', height: 'fit-content' } : {}) });
      for (const k of kids) s.doc.updateStyle(k, FLOW_PATCH);
    });
    return;
  }
  const rects = sel.flatMap((id) => (rectOf(id) ? [{ id, r: rectOf(id)! }] : []));
  const u = unionRects(rects.map((r) => r.r));
  if (!u) return;
  const horizontal = u.w >= u.h;
  const ordered = [...rects].sort((a, b) => (horizontal ? a.r.x - b.r.x : a.r.y - b.r.y));
  const gaps = ordered.slice(1).map((o, i) => (horizontal ? o.r.x - ordered[i]!.r.x - ordered[i]!.r.w : o.r.y - ordered[i]!.r.y - ordered[i]!.r.h));
  const gap = gaps.length ? Math.max(0, Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)) : 8;
  const id = wrap(ordered.map((o) => o.id), { name: 'Frame', flex: true, style: { display: 'flex', flexDirection: horizontal ? 'row' : 'column', gap: `${gap}px`, width: 'fit-content', height: 'fit-content', alignItems: 'flex-start' } });
  if (id) {
    s.tx(() => s.doc.move(ordered.map((o) => o.id), id));
    editor().set({ selection: [id] });
  }
}

/** Removes the frames around their children, leaving everything where it was on screen. */
export function ungroupSelection(): void {
  const s = session();
  const { snap, doc } = s;
  const frames = topLevelOf(editor().selection).filter((id) => !isVirtualId(id) && snap.nodes.get(id)?.instanceOf === undefined && snap.nodes.get(id)?.type === 'frame' && snap.children(id).length);
  if (!frames.length) return;
  const out: string[] = [];
  flushSync(() => {
    s.tx(() => {
      for (const f of frames) {
        const parent = snap.nodes.get(f)!.parent;
        const flowInto = flowOf(parent).kind === 'flow';
        const kids = [...snap.children(f)];
        const at = snap.children(parent).indexOf(f);
        for (const k of kids) doc.updateStyle(k, flowInto ? FLOW_PATCH : placement(k, parent));
        doc.move(kids, parent, at);
        out.push(...kids);
        // Not doc.delete: it walks children as they were before this transaction, kids included.
        doc.nodes.delete(f);
      }
    });
  });
  editor().set({ selection: out });
}

function escapeSvgAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** Paths of one layer in world coordinates; empty for layers that have no vector meaning. */
function vectorPartsOf(id: string): string[] {
  const s = session();
  const n = s.snap.nodes.get(id);
  const m = measure(id);
  if (!n || !m) return [];
  const { x, y, w, h, rot } = m.box;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const transform = `rotate(${fmt(rot)} ${fmt(cx)} ${fmt(cy)})`;
  const fill = n.style.backgroundColor ?? 'none';
  if (n.type === 'frame') {
    if (fill === 'none') return [];
    const ellipse = n.style.borderRadius === '50%' || n.style.borderRadius === '9999px';
    const r = px(n.style.borderRadius);
    const shape = ellipse
      ? `<ellipse cx="${fmt(cx)}" cy="${fmt(cy)}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}"`
      : `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(w)}" height="${fmt(h)}" rx="${fmt(r)}"`;
    return [`${shape} fill="${escapeSvgAttr(fill)}" transform="${transform}"/>`];
  }
  if (n.type === 'svg' && n.svg) {
    const doc = new DOMParser().parseFromString(n.svg, 'image/svg+xml');
    const root = doc.documentElement;
    if (root.nodeName !== 'svg') return [];
    const vb = (root.getAttribute('viewBox') ?? `0 0 ${fmt(w)} ${fmt(h)}`).split(/[\s,]+/).map(parseFloat);
    const sx = w / (vb[2] || w || 1);
    const sy = h / (vb[3] || h || 1);
    const inner = [...root.childNodes].map((c) => new XMLSerializer().serializeToString(c)).join('');
    const attrs = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'].flatMap((a) => {
      const v = root.getAttribute(a);
      return v ? [`${a}="${escapeSvgAttr(v)}"`] : [];
    }).join(' ');
    return [`<g ${attrs} transform="${transform} translate(${fmt(x)} ${fmt(y)}) scale(${fmt(sx, 4)} ${fmt(sy, 4)}) translate(${fmt(-(vb[0] ?? 0))} ${fmt(-(vb[1] ?? 0))})">${inner}</g>`];
  }
  return [];
}

/** Merges rectangles, ellipses and vectors of the selection into one vector layer. */
export function flattenSelection(): void {
  const s = session();
  const { snap, doc } = s;
  const top = inTreeOrder(topLevelOf(editor().selection)).filter((id) => !isVirtualId(id));
  if (!top.length) return;
  const parts: string[] = [];
  const rects: Rect[] = [];
  const consumed: string[] = [];
  const skipped: string[] = [];
  const visit = (id: string, root: string) => {
    const n = snap.nodes.get(id);
    if (!n) return;
    if (n.type === 'text' || n.type === 'image' || n.type === 'shader' || n.type === 'video' || n.type === 'embed') {
      skipped.push(id);
      return;
    }
    const p = vectorPartsOf(id);
    if (p.length) {
      parts.push(...p);
      rects.push(measure(id)!.rect);
    }
    if (!consumed.includes(root)) consumed.push(root);
    for (const c of snap.children(id)) visit(c, root);
  };
  for (const id of top) visit(id, id);
  const bounds = unionRects(rects);
  if (!bounds || !parts.length) {
    editor().showToast(t('Nothing to flatten. Text and images stay as they are.'));
    return;
  }
  const parent = snap.nodes.get(top[0]!)!.parent;
  const local = toParentLocal(parent, bounds);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="${fmt(bounds.x)} ${fmt(bounds.y)} ${fmt(bounds.w)} ${fmt(bounds.h)}" preserveAspectRatio="none" overflow="visible">${parts.join('')}</svg>`;
  let id = '';
  const index = snap.children(parent).indexOf(top.at(-1)!) + 1;
  s.tx(() => {
    if (snap.nodes.has(parent)) ensurePositioned(parent);
    id = doc.insert(parent, { type: 'svg', name: 'Vector', svg, style: { position: 'absolute', left: fmtPx(local.x), top: fmtPx(local.y), width: fmtPx(bounds.w), height: fmtPx(bounds.h) } }, index);
    doc.delete(consumed.filter((c) => !skipped.some((k) => k === c || snap.ancestors(k).includes(c))));
  });
  editor().set({ selection: [id] });
  if (skipped.length) editor().showToast(t('Text and images were left out of the flattened vector.'));
}

/** A new vector layer from paths in world coordinates. */
export function createPathLayer(paths: SubPath[], parent: string, name = 'Vector', stroke = '#111111', strokeWidth = 2): string {
  const s = session();
  const b = boundsOf(paths);
  const w = Math.max(b.w, 1);
  const h = Math.max(b.h, 1);
  const local = toParentLocal(parent, b);
  const d = pathToD(translatePaths(paths, -b.x, -b.y));
  const fill = paths.some((p) => p.closed) ? '#d9d9d9' : 'none';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${fmt(w)} ${fmt(h)}" preserveAspectRatio="none" overflow="visible"><path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  let id = '';
  s.tx(() => {
    if (s.snap.nodes.has(parent)) ensurePositioned(parent);
    id = s.doc.insert(parent, { type: 'svg', name, svg, style: { position: 'absolute', left: fmtPx(local.x), top: fmtPx(local.y), width: fmtPx(w), height: fmtPx(h) } });
  });
  return id;
}

/** Inserts a layer tree into a parent at a world position, honouring the parent's layout. */
export function insertAt(parent: string, spec: NewNode, world: Vec): string {
  const s = session();
  const flow = s.snap.nodes.has(parent) && flowOf(parent).kind === 'flow';
  const local = toParentLocal(parent, world);
  const style: Record<string, string> = { ...spec.style };
  if (flow) for (const k of POSITION_KEYS) delete style[k];
  else {
    style.position = 'absolute';
    style.left = fmtPx(local.x);
    style.top = fmtPx(local.y);
  }
  let id = '';
  flushSync(() => {
    s.tx(() => {
      if (!flow && s.snap.nodes.has(parent)) ensurePositioned(parent);
      id = s.doc.insert(parent, { ...spec, style });
    });
  });
  return id;
}

export function visibleCentre(): Vec {
  const v = camera.visibleWorld();
  return { x: v.x + v.w / 2, y: v.y + v.h / 2 };
}

/** Where a duplicate-free new artboard goes: to the right of everything on the page. */
export function freeSpotRight(width: number, height: number): Vec {
  const { snap } = session();
  const top = snap.children(pageId());
  const rects = top.flatMap((id) => rectOf(id) ?? []);
  const u = unionRects(rects);
  if (!u) {
    const c = visibleCentre();
    return { x: Math.round(c.x - width / 2), y: Math.round(c.y - height / 2) };
  }
  return { x: Math.round(u.x + u.w + 80), y: Math.round(u.y) };
}

export function addArtboard(name: string, width: number, height: number): string {
  const s = session();
  const spot = freeSpotRight(width, height);
  const page = pageId();
  let id = '';
  flushSync(() => {
    s.tx(() => {
      id = s.doc.insert(page, { type: 'frame', name, artboard: true, style: { position: 'absolute', left: fmtPx(spot.x), top: fmtPx(spot.y), width: fmtPx(width), height: fmtPx(height), backgroundColor: '#ffffff', overflow: 'hidden' } });
    });
  });
  selectAndMove([id]);
  const r = rectOf(id);
  if (r) {
    const v = camera.visibleWorld();
    if (r.x < v.x || r.y < v.y || r.x + r.w > v.x + v.w || r.y + r.h > v.y + v.h) camera.fit(r, 1);
  }
  return id;
}

export function fitAll(): void {
  const { snap } = session();
  const u = unionRects(snap.children(pageId()).flatMap((id) => rectOf(id) ?? []));
  if (u) {
    const planned = readCanvasPlan(session().doc, pageId()).sections.length > 0;
    camera.fit(planned ? { x: u.x - 80, y: u.y - 180, w: u.w + 160, h: u.h + 260 } : u, 1);
  }
  else camera.set({ x: camera.width / 2, y: camera.height / 2, z: 1 }, false);
}

export function fitSelection(): void {
  const u = unionRects(editor().selection.flatMap((id) => rectOf(id) ?? []));
  if (u) camera.fit(u, 4);
  // Nothing selected: the artboard in view, not every artboard of what may be a large file.
  else fitScreen('screen');
}

export function undo(): void {
  const s = session();
  s.undo.undo();
}

export function redo(): void {
  const s = session();
  s.undo.redo();
}

export function toggleTextStyle(key: 'fontWeight' | 'fontStyle' | 'textDecorationLine', on: string, off: string | null): void {
  const s = session();
  const nodes = editor().selection.flatMap((id) => s.snap.nodes.get(id) ?? []);
  if (!nodes.length) return;
  const allOn = nodes.every((n) => n.style[key] === on);
  setStyle(nodes.map((n) => n.id), { [key]: allOn ? off : on });
}

export function adjustTextStyle(key: 'fontSize' | 'lineHeight' | 'letterSpacing' | 'fontWeight', delta: number): void {
  const s = session();
  s.tx(() => {
    for (const id of editor().selection) {
      const n = s.snap.nodes.get(id);
      const el = elOf(id);
      if (!n || !el) continue;
      const cs = getComputedStyle(el);
      const cssKey = key as 'fontSize';
      const current = parseFloat(cs[cssKey]);
      if (key === 'fontWeight') s.doc.updateStyle(id, { fontWeight: String(Math.min(900, Math.max(100, (Number.isNaN(current) ? 400 : current) + delta))) });
      else s.doc.updateStyle(id, { [key]: fmtPx((Number.isNaN(current) ? 0 : current) + delta) });
    }
  });
}
