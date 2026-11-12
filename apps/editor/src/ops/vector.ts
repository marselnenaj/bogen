import type { BogenNode, NewNode } from '@bogen/core';
import { flushSync } from 'react-dom';
import type { LocalBox } from '../canvas/geometry.ts';
import { computedBox, measure, toParentLocal } from '../canvas/measure.ts';
import { boundsOf, parseD, pathToD, translatePaths, type SubPath } from '../canvas/path.ts';
import { session } from '../doc/session.ts';
import { fmt, fmtPx, px, radiiOf } from '../lib/css-values.ts';
import { parseFills } from '../lib/fills.ts';
import { ellipsePath, IDENTITY_M, multiplyM, parseTransformAttr, roundedRectPath, transformPaths, type Matrix } from '../lib/shape-paths.ts';
import { editor } from '../state/store.ts';
import { ensurePositioned, inTreeOrder, topLevelOf } from './ops.ts';
import { t } from '../i18n/store.ts';

/** Boolean operations and converting shapes to paths. Results are ordinary paths, editable node by node. */
export type BooleanKind = 'union' | 'subtract' | 'intersect' | 'exclude';
const BOOLEAN_NAMES: Record<BooleanKind, string> = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' };

function solidFill(n: BogenNode): { color: string; lost: boolean } {
  const fills = parseFills(n.style);
  const solid = [...fills].reverse().find((f) => f.kind === 'solid');
  const first = fills[0];
  if (first?.kind === 'solid') return { color: first.color, lost: fills.length > 1 };
  if (first && 'stops' in first) return { color: first.stops[0]?.color ?? '#d9d9d9', lost: true };
  return { color: solid?.kind === 'solid' ? solid.color : 'none', lost: Boolean(first) };
}

function strokeOf(n: BogenNode): { stroke: string; width: number } | null {
  const width = px(n.style.borderWidth);
  const color = n.style.borderColor;
  if (width > 0 && color && n.style.borderStyle !== 'none') return { stroke: color, width };
  return null;
}

const isLine = (n: BogenNode) => n.type === 'frame' && /^Line\b/.test(n.name);

/** A frame with nothing inside that reads as a shape: a rectangle, a rounded one, an ellipse or a line. */
export function isShape(n: BogenNode): boolean {
  if (n.type !== 'frame' || session().snap.children(n.id).length) return false;
  return !n.artboard;
}

/** The layer's outline in its own pixels. */
function ownPaths(n: BogenNode, w: number, h: number): SubPath[] | null {
  if (n.type === 'frame') {
    if (isLine(n)) return [{ closed: false, points: [{ x: 0, y: h / 2 }, { x: w, y: h / 2 }] }];
    const radii = radiiOf(n.style);
    const pct = radii.map((r) => r.endsWith('%'));
    const values = radii.map((r, i) => (pct[i] ? (parseFloat(r) / 100) * Math.max(w, h) : px(r))) as [number, number, number, number];
    if (radii.every((r) => r === '50%') || (radii.every((r) => r === radii[0]) && pct[0] && parseFloat(radii[0]) >= 50)) return [ellipsePath(0, 0, w, h)];
    return [roundedRectPath(0, 0, w, h, values)];
  }
  if (n.type === 'svg' && n.svg) return svgPaths(n.svg, w, h);
  return null;
}

const nums = (el: Element, ...names: string[]) => names.map((a) => parseFloat(el.getAttribute(a) ?? '0') || 0);

function elementPaths(el: Element): SubPath[] {
  switch (el.nodeName.toLowerCase()) {
    case 'path': return parseD(el.getAttribute('d') ?? '');
    case 'rect': {
      const [x, y, w, h, rx, ry] = nums(el, 'x', 'y', 'width', 'height', 'rx', 'ry') as [number, number, number, number, number, number];
      const r = rx || ry;
      return w && h ? [roundedRectPath(x, y, w, h, [r, r, r, r])] : [];
    }
    case 'circle': {
      const [cx, cy, r] = nums(el, 'cx', 'cy', 'r') as [number, number, number];
      return r ? [ellipsePath(cx - r, cy - r, r * 2, r * 2)] : [];
    }
    case 'ellipse': {
      const [cx, cy, rx, ry] = nums(el, 'cx', 'cy', 'rx', 'ry') as [number, number, number, number];
      return rx && ry ? [ellipsePath(cx - rx, cy - ry, rx * 2, ry * 2)] : [];
    }
    case 'line': {
      const [x1, y1, x2, y2] = nums(el, 'x1', 'y1', 'x2', 'y2') as [number, number, number, number];
      return [{ closed: false, points: [{ x: x1, y: y1 }, { x: x2, y: y2 }] }];
    }
    case 'polyline': case 'polygon': {
      const v = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(parseFloat);
      const points = [];
      for (let i = 0; i + 1 < v.length; i += 2) points.push({ x: v[i]!, y: v[i + 1]! });
      return points.length ? [{ closed: el.nodeName.toLowerCase() === 'polygon', points }] : [];
    }
    default: return [];
  }
}

/** Every shape in vector markup, in the pixels of a layer of this size, with transforms applied. */
export function svgPaths(markup: string, w: number, h: number): SubPath[] | null {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg') return null;
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(parseFloat);
  const vw = vb[2] || w || 1;
  const vh = vb[3] || h || 1;
  const fit = root.getAttribute('preserveAspectRatio') ?? 'xMidYMid meet';
  let m: Matrix;
  if (fit.startsWith('none')) m = [w / vw, 0, 0, h / vh, (-(vb[0] || 0) * w) / vw, (-(vb[1] || 0) * h) / vh];
  else {
    const s = Math.min(w / vw, h / vh);
    m = [s, 0, 0, s, (w - vw * s) / 2 - (vb[0] || 0) * s, (h - vh * s) / 2 - (vb[1] || 0) * s];
  }
  const out: SubPath[] = [];
  const walk = (el: Element, at: Matrix) => {
    const name = el.nodeName.toLowerCase();
    if (name === 'defs' || name === 'clippath' || name === 'mask' || name === 'marker' || name === 'symbol' || name === 'pattern') return;
    const here = multiplyM(at, parseTransformAttr(el.getAttribute('transform')));
    out.push(...transformPaths(elementPaths(el), here));
    for (const c of el.children) walk(c, here);
  };
  for (const c of root.children) walk(c, m);
  return out.length ? out : null;
}

/** A layer's outline in world coordinates. */
function worldPaths(n: BogenNode): SubPath[] | null {
  const m = measure(n.id);
  const box = computedBox(n.id);
  if (!m || !box) return null;
  const own = ownPaths(n, box.width, box.height);
  if (!own) return null;
  const b: LocalBox = m.box;
  const r = (b.rot * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const sx = box.width ? b.w / box.width : 1;
  const sy = box.height ? b.h / box.height : 1;
  // Around the centre of the box, as CSS rotates it.
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const hw = box.width / 2;
  const hh = box.height / 2;
  const toWorld: Matrix = [cos * sx, sin * sx, -sin * sy, cos * sy, cx - cos * sx * hw + sin * sy * hh, cy - sin * sx * hw - cos * sy * hh];
  return transformPaths(own, toWorld);
}

function pathMarkup(d: string, attrs: Record<string, string>, w: number, h: number): string {
  const a = Object.entries(attrs).map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${fmt(w)} ${fmt(h)}" preserveAspectRatio="none" overflow="visible"><path d="${d}"${a}/></svg>`;
}

const DROPPED_ON_PATH = new Set(['backgroundColor', 'backgroundImage', 'background', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat', 'borderRadius', 'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius', 'border', 'borderWidth', 'borderStyle', 'borderColor', 'overflow', 'display', 'flexDirection', 'gap', 'padding']);

/** Rectangles, ellipses and lines become one path each, in the same place. */
export function shapeToPath(ids: string[] = editor().selection): string[] {
  const s = session();
  const { snap, doc } = s;
  const out: string[] = [];
  let lost = false;
  let skipped = 0;
  const work: { id: string; next: NewNode; parent: string; index: number }[] = [];
  for (const id of topLevelOf(ids)) {
    const n = snap.nodes.get(id);
    const box = computedBox(id);
    if (!n || !box) continue;
    const already = n.type === 'svg' && n.svg && /<path\b/.test(n.svg) && !/<(rect|circle|ellipse|line|polyline|polygon)\b/.test(n.svg);
    if (already) { out.push(id); continue; }
    if (!(n.type === 'svg' || isShape(n))) { skipped++; continue; }
    const paths = ownPaths(n, box.width, box.height);
    if (!paths) { skipped++; continue; }
    const style = Object.fromEntries(Object.entries(n.style).filter(([k]) => !DROPPED_ON_PATH.has(k)));
    style.width = fmtPx(box.width);
    style.height = fmtPx(box.height);
    let attrs: Record<string, string>;
    if (n.type === 'frame' && isLine(n)) attrs = { fill: 'none', stroke: n.style.backgroundColor ?? '#111111', 'stroke-width': fmt(box.height) };
    else if (n.type === 'svg') {
      const drawing = (n.svg ?? '').replace(/<defs[\s\S]*?<\/defs>/g, '');
      const pick = (name: string, fallback: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(drawing)?.[1] ?? fallback;
      attrs = { fill: pick('fill', '#000000'), stroke: pick('stroke', 'none'), 'stroke-width': pick('stroke-width', '1') };
    } else {
      const f = solidFill(n);
      if (f.lost) lost = true;
      const st = strokeOf(n);
      attrs = { fill: f.color, ...(st ? { stroke: st.stroke, 'stroke-width': fmt(st.width) } : {}) };
    }
    work.push({
      id, parent: n.parent, index: snap.children(n.parent).indexOf(id),
      next: { type: 'svg', tag: 'svg', name: n.name === 'Rectangle' || n.name === 'Ellipse' || n.name === 'Line' ? 'Vector' : n.name, style, svg: pathMarkup(pathToD(paths), attrs, box.width, box.height), ...(n.proto ? { proto: n.proto } : {}) },
    });
  }
  if (!work.length) {
    if (!out.length) editor().showToast(skipped ? t('Only shapes without children can become paths.') : t('Select a shape first.'));
    return out;
  }
  flushSync(() => {
    s.tx(() => {
      for (const w of work) {
        const nid = doc.insert(w.parent, w.next, w.index);
        doc.delete([w.id]);
        out.push(nid);
      }
    });
  });
  editor().set({ selection: out });
  if (lost) editor().showToast(t('Paths have one solid fill here. Extra and gradient fills became their first colour.'));
  return out;
}

type Paper = typeof import('paper/dist/paper-core');
let paperLoad: Promise<Paper> | null = null;

/** Loaded the first time shapes are combined, as most sessions never do. */
function loadPaper(): Promise<Paper> {
  if (!paperLoad) {
    paperLoad = import('paper/dist/paper-core').then((m) => {
      const p = ((m as unknown as { default?: Paper }).default ?? m) as Paper;
      p.setup(new p.Size(1, 1));
      return p;
    });
  }
  return paperLoad;
}

function toPaper(p: Paper, subs: SubPath[]): paper.PathItem {
  const children = subs.filter((s) => s.points.length > 1).map((s) => new p.Path({
    closed: true,
    insert: false,
    segments: s.points.map((pt) => new p.Segment(
      new p.Point(pt.x, pt.y),
      pt.hx1 !== undefined ? new p.Point(pt.hx1 - pt.x, pt.hy1! - pt.y) : undefined,
      pt.hx2 !== undefined ? new p.Point(pt.hx2 - pt.x, pt.hy2! - pt.y) : undefined,
    )),
  }));
  const compound = new p.CompoundPath({ children, insert: false, fillRule: 'evenodd' });
  return compound as unknown as paper.PathItem;
}

function fromPaper(item: paper.PathItem): SubPath[] {
  const paths: paper.Path[] = item.className === 'CompoundPath' ? ((item as paper.CompoundPath).children as paper.Path[]) : [item as paper.Path];
  return paths.filter((path) => path.segments.length > 1).map((path) => ({
    closed: path.closed,
    points: path.segments.map((seg) => ({
      x: seg.point.x, y: seg.point.y,
      ...(seg.handleIn.isZero() ? {} : { hx1: seg.point.x + seg.handleIn.x, hy1: seg.point.y + seg.handleIn.y }),
      ...(seg.handleOut.isZero() ? {} : { hx2: seg.point.x + seg.handleOut.x, hy2: seg.point.y + seg.handleOut.y }),
    })),
  }));
}

/** Combines the selected shapes into one path, which replaces them. Painted bottom layer first. */
export async function booleanOp(kind: BooleanKind): Promise<string | null> {
  const s = session();
  const { snap, doc } = s;
  const ids = inTreeOrder(topLevelOf(editor().selection));
  if (ids.length < 2) {
    editor().showToast(t('Select at least two shapes to combine.'));
    return null;
  }
  const nodes = ids.flatMap((id) => snap.nodes.get(id) ?? []);
  const parts = nodes.map((n) => ((n.type === 'frame' && !isShape(n)) ? null : worldPaths(n)));
  if (parts.some((p) => !p)) {
    editor().showToast(t('Only shapes and vectors can be combined. Text and images cannot.'));
    return null;
  }
  const p = await loadPaper();
  let result = toPaper(p, parts[0]!);
  for (const part of parts.slice(1)) {
    const next = toPaper(p, part!);
    if (kind === 'union') result = result.unite(next, { insert: false });
    else if (kind === 'subtract') result = result.subtract(next, { insert: false });
    else if (kind === 'intersect') result = result.intersect(next, { insert: false });
    else result = result.exclude(next, { insert: false });
  }
  const subs = fromPaper(result);
  if (!subs.length) {
    editor().showToast(t('These shapes leave nothing behind for that operation.'));
    return null;
  }
  const b = boundsOf(subs);
  const w = Math.max(1, b.w);
  const h = Math.max(1, b.h);
  const d = pathToD(translatePaths(subs, -b.x, -b.y));
  const base = nodes[0]!;
  const parent = base.parent;
  const fill = base.type === 'svg' ? (/\bfill="([^"]*)"/.exec((base.svg ?? '').replace(/<defs[\s\S]*?<\/defs>/g, ''))?.[1] ?? '#000000') : solidFill(base).color;
  const stroke = base.type === 'frame' ? strokeOf(base) : null;
  const local = toParentLocal(parent, b);
  let id = '';
  const index = snap.children(parent).indexOf(ids.at(-1)!);
  flushSync(() => {
    s.tx(() => {
      if (snap.nodes.has(parent)) ensurePositioned(parent);
      id = doc.insert(parent, {
        type: 'svg', tag: 'svg', name: BOOLEAN_NAMES[kind],
        style: { position: 'absolute', left: fmtPx(local.x), top: fmtPx(local.y), width: fmtPx(w), height: fmtPx(h) },
        svg: pathMarkup(d, { fill: fill === 'none' ? '#d9d9d9' : fill, 'fill-rule': 'evenodd', ...(stroke ? { stroke: stroke.stroke, 'stroke-width': fmt(stroke.width) } : {}) }, w, h),
      }, index + 1);
      doc.delete(ids);
    });
  });
  editor().set({ selection: [id] });
  return id;
}

export const canBoolean = (nodes: BogenNode[]): boolean => nodes.length >= 2 && nodes.every((n) => n.type === 'svg' || isShape(n));

// Stroke details of a vector layer, stored as plain SVG.

export type CapKind = 'none' | 'arrow' | 'triangle' | 'circle' | 'bar';
export type StrokeAlign = 'center' | 'inside' | 'outside';

const CAP_SHAPES: Record<Exclude<CapKind, 'none'>, { view: string; refX: number; shape: string }> = {
  arrow: { view: '0 0 10 10', refX: 8.5, shape: '<path d="M1.5 1.5L8.5 5L1.5 8.5" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' },
  triangle: { view: '0 0 10 10', refX: 8, shape: '<path d="M0 0.5L10 5L0 9.5Z" fill="context-stroke"/>' },
  circle: { view: '0 0 10 10', refX: 5, shape: '<circle cx="5" cy="5" r="4" fill="context-stroke"/>' },
  bar: { view: '0 0 10 10', refX: 5, shape: '<path d="M5 0.5V9.5" fill="none" stroke="context-stroke" stroke-width="1.5"/>' },
};

function parseMarkup(markup: string): { doc: Document; root: Element; paths: Element[] } | null {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const root = doc.documentElement;
  if (root.nodeName !== 'svg') return null;
  return { doc, root, paths: [...root.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse')].filter((el) => !el.closest('defs')) };
}

const NS = 'http://www.w3.org/2000/svg';

function defsOf(doc: Document, root: Element): Element {
  let defs = root.querySelector('defs');
  if (!defs) {
    defs = doc.createElementNS(NS, 'defs');
    root.insertBefore(defs, root.firstChild);
  }
  return defs;
}

export function capsOf(markup: string): { start: CapKind; end: CapKind } {
  const parsed = parseMarkup(markup);
  const read = (attr: string): CapKind => {
    const v = parsed?.paths[0]?.getAttribute(attr);
    const m = v ? /url\(#[\w-]*-(arrow|triangle|circle|bar)\)/.exec(v) : null;
    return (m?.[1] as CapKind | undefined) ?? 'none';
  };
  return { start: read('marker-start'), end: read('marker-end') };
}

export function setCap(id: string, which: 'start' | 'end', kind: CapKind): void {
  const s = session();
  const n = s.snap.nodes.get(id);
  if (!n?.svg) return;
  const parsed = parseMarkup(n.svg);
  if (!parsed) return;
  const { doc, root, paths } = parsed;
  const attr = which === 'start' ? 'marker-start' : 'marker-end';
  for (const el of paths) {
    if (kind === 'none') el.removeAttribute(attr);
    else el.setAttribute(attr, `url(#${id}-${which}-${kind})`);
  }
  if (kind !== 'none') {
    const defs = defsOf(doc, root);
    const mid = `${id}-${which}-${kind}`;
    if (!root.querySelector(`[id="${mid}"]`)) {
      const c = CAP_SHAPES[kind];
      const holder = new DOMParser().parseFromString(`<svg xmlns="${NS}"><marker id="${mid}" viewBox="${c.view}" refX="${which === 'start' ? 10 - c.refX : c.refX}" refY="5" markerWidth="5" markerHeight="5" markerUnits="strokeWidth" orient="${which === 'start' ? 'auto-start-reverse' : 'auto'}" overflow="visible">${c.shape}</marker></svg>`, 'image/svg+xml');
      defs.appendChild(doc.importNode(holder.documentElement.firstElementChild!, true));
    }
  }
  // Markers no path refers to any more go away.
  const usedValues = paths.flatMap((el) => [el.getAttribute('marker-start'), el.getAttribute('marker-end')]);
  for (const m of [...root.querySelectorAll('marker')]) if (!usedValues.includes(`url(#${m.getAttribute('id')})`)) m.remove();
  const defs = root.querySelector('defs');
  if (defs && !defs.children.length) defs.remove();
  s.tx(() => s.doc.updateFields(id, { svg: new XMLSerializer().serializeToString(root) }));
}

export function strokeAlignOf(markup: string): StrokeAlign {
  if (/\bclip-path="url\(#[\w-]*-inside\)"/.test(markup)) return 'inside';
  if (/\bpaint-order="stroke"/.test(markup)) return 'outside';
  return 'center';
}

/** The width a person set. An aligned stroke is drawn twice as wide with one half hidden. */
export function strokeWidthOf(markup: string): number {
  const w = parseFloat(/\bstroke-width="([^"]*)"/.exec(markup.replace(/<defs[\s\S]*?<\/defs>/g, ''))?.[1] ?? '0') || 0;
  return strokeAlignOf(markup) === 'center' ? w : w / 2;
}

export function setStrokeAlign(id: string, align: StrokeAlign): void {
  const s = session();
  const n = s.snap.nodes.get(id);
  if (!n?.svg) return;
  const parsed = parseMarkup(n.svg);
  if (!parsed) return;
  const { doc, root, paths } = parsed;
  const before = strokeAlignOf(n.svg);
  if (before === align) return;
  const width = strokeWidthOf(n.svg);
  const clipId = `${id}-inside`;
  root.querySelector(`[id="${clipId}"]`)?.remove();
  paths.forEach((el, i) => {
    el.removeAttribute('clip-path');
    el.removeAttribute('paint-order');
    if (el.getAttribute('id')?.startsWith(`${id}-shape-`)) el.removeAttribute('id');
    if (el.hasAttribute('stroke-width') || width) el.setAttribute('stroke-width', fmt(align === 'center' ? width : width * 2));
    if (align === 'inside') {
      el.setAttribute('id', `${id}-shape-${i}`);
      el.setAttribute('clip-path', `url(#${clipId})`);
    }
    if (align === 'outside') el.setAttribute('paint-order', 'stroke');
  });
  if (align === 'inside') {
    const clip = doc.createElementNS(NS, 'clipPath');
    clip.setAttribute('id', clipId);
    paths.forEach((_, i) => {
      const use = doc.createElementNS(NS, 'use');
      use.setAttribute('href', `#${id}-shape-${i}`);
      clip.appendChild(use);
    });
    defsOf(doc, root).appendChild(clip);
  }
  const defs = root.querySelector('defs');
  if (defs && !defs.children.length) defs.remove();
  s.tx(() => s.doc.updateFields(id, { svg: new XMLSerializer().serializeToString(root) }));
}

export function setStrokeWidth(id: string, width: number): void {
  const s = session();
  const n = s.snap.nodes.get(id);
  if (!n?.svg) return;
  const parsed = parseMarkup(n.svg);
  if (!parsed) return;
  const value = fmt(strokeAlignOf(n.svg) === 'center' ? width : width * 2);
  for (const el of parsed.paths) el.setAttribute('stroke-width', value);
  s.tx(() => s.doc.updateFields(id, { svg: new XMLSerializer().serializeToString(parsed.root) }));
}

export function isClosedMarkup(markup: string): boolean {
  const parsed = parseMarkup(markup);
  return Boolean(parsed?.paths.length) && parsed!.paths.every((el) => {
    const name = el.nodeName.toLowerCase();
    if (name === 'path') return /z\s*$/i.test(el.getAttribute('d') ?? '');
    return name !== 'line' && name !== 'polyline';
  });
}
