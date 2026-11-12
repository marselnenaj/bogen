import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { agentMentions, type CommentAttachment } from '@bogen/core';
import { useChildren, useComments, useFrameVersion } from '../doc/hooks.ts';
import { setCursorChat } from '../doc/presence.ts';
import { session } from '../doc/session.ts';
import { camera } from '../state/camera.ts';
import { editor, useEditor } from '../state/store.ts';
import { fmt, paddingOf } from '../lib/css-values.ts';
import { apply, handleCursor, measureBetween, rotation, unionRects, type HandleId, type LocalBox, type Rect, type Vec } from './geometry.ts';
import { computedBox, elOf, flowOf, isFlow, measure as measureRaw, measureOnScreen as measure, rectOf } from './measure.ts';
import { onOverlayTick, tickOverlay } from './overlay-tick.ts';
import { usePathEdit, usePen } from './pen.ts';
import { pathToD, type PathPoint } from './path.ts';
import { askAgentInComment } from '../ops/comments.ts';
import { CommentRunChoice } from '../panels/RunChoice.tsx';
import { topLevelOf, setFields } from '../ops/ops.ts';
import { lastPointerPos } from './pointer.ts';
import { CanvasSections } from './CanvasSections.tsx';
import { BrandMarkers } from './BrandMarkers.tsx';
import { DriftOverlay } from './DriftOverlay.tsx';
import { FindHighlights } from './FindBar.tsx';
import { LayoutGridsLayer } from './LayoutGrids.tsx';
import { SpacingHandles } from './SpacingHandles.tsx';
import { readableOn } from '../lib/readable.ts';
import { CommentInput } from '../panels/CommentInput.tsx';
import { GradientHandles } from './GradientHandles.tsx';
import { CropHandles } from './CropHandles.tsx';
import { useUi } from '../state/ui.ts';
import { msg } from '../i18n/core.ts';
import { useT } from '../i18n/react.ts';

/** Re-renders on every camera change, explicit tick and document change. Only for small subtrees. */
function useFrame(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((v) => v + 1);
    const a = camera.subscribe(bump);
    const b = onOverlayTick(bump);
    const c = session().snap.subscribe(tickOverlay);
    return () => { a(); b(); c(); };
  }, []);
  return n;
}

const sx = (x: number) => x * camera.value.z + camera.value.x;
const sy = (y: number) => y * camera.value.z + camera.value.y;

function screenRect(r: Rect): CSSProperties {
  const z = camera.value.z;
  return { left: sx(r.x), top: sy(r.y), width: r.w * z, height: r.h * z };
}

// World-anchored items positioned purely by CSS, so that panning touches no React state.

function anchored(x: number, y: number): CSSProperties {
  return { '--wx': x, '--wy': y } as CSSProperties;
}

function PixelGrid() {
  useFrame();
  const { x, y, z } = camera.value;
  if (z < 6) return null;
  return <div className="ov-grid" style={{ backgroundSize: `${z}px ${z}px`, backgroundPosition: `${x}px ${y}px` }} />;
}

function FrameLabels() {
  const pageId = useEditor((s) => s.pageId);
  return pageId ? <FrameLabelsOn pageId={pageId} /> : null;
}

function FrameLabelsOn({ pageId }: { pageId: string }) {
  useChildren(pageId);
  useFrameVersion();
  const { snap } = session();
  const selection = useEditor((s) => s.selection);
  const renaming = useEditor((s) => s.renamingLabelId);
  const tick = useFrameTickOnly();
  void tick;
  const frames = snap.children(pageId).flatMap((id) => {
    const n = snap.nodes.get(id);
    return n && n.artboard && !n.hidden ? [n] : [];
  }).slice(0, 400);
  return (
    <>
      {frames.map((n) => {
        const r = rectOf(n.id);
        if (!r) return null;
        const selected = selection.includes(n.id);
        return (
          <div key={n.id} className={`ov-frame-label${selected ? ' is-selected' : ''}`} style={{ ...anchored(r.x, r.y), '--ww': r.w, ...(renaming === n.id ? { maxWidth: 'none' } : {}) } as CSSProperties} data-frame-label={n.id}>
            {renaming === n.id ? (
              <input
                data-ui
                autoFocus
                dir="auto"
                className="ov-frame-rename"
                defaultValue={n.name}
                onFocus={(e) => e.currentTarget.select()}
                onBlur={(e) => { setFields([n.id], { name: e.currentTarget.value || n.name }); editor().set({ renamingLabelId: null }); }}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') editor().set({ renamingLabelId: null });
                }}
              />
            ) : n.name}
          </div>
        );
      })}
    </>
  );
}

function useFrameTickOnly(): number {
  const [n, setN] = useState(0);
  useEffect(() => onOverlayTick(() => setN((v) => v + 1)), []);
  return n;
}

function Outline({ box, className, color }: { box: LocalBox; className?: string; color?: string }) {
  const z = camera.value.z;
  const style: CSSProperties = {
    width: box.w * z,
    height: box.h * z,
    transform: `translate(${sx(box.x)}px, ${sy(box.y)}px) rotate(${box.rot}deg)`,
    ...(color ? { borderColor: color } : {}),
  };
  return <div className={`ov-outline ${className ?? ''}`} style={style} />;
}

/**
 * An outline kept on its layer by CSS alone: world coordinates here, the camera's --cx, --cy and --z on the overlay,
 * which the camera writes on every move. A pan or zoom moves it in the same frame as the canvas, with no render.
 */
function AnchoredOutline({ box, className, color, testId }: { box: LocalBox; className?: string; color?: string; testId?: string }) {
  const style = { '--wx': box.x, '--wy': box.y, '--ww': box.w, '--wh': box.h, '--rot': box.rot, ...(color ? { borderColor: color } : {}) } as CSSProperties;
  return <div className={`ov-outline is-anchored ${className ?? ''}`} style={style} data-testid={testId} />;
}

/** Re-renders when layers change or the overlay is ticked, but not when the camera moves. */
function useLayerFrame(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((v) => v + 1);
    const b = onOverlayTick(bump);
    const c = session().snap.subscribe(tickOverlay);
    return () => { b(); c(); };
  }, []);
  return n;
}

function HoverOutline() {
  useFrame();
  const hoverId = useEditor((s) => s.hoverId);
  const selection = useEditor((s) => s.selection);
  const gesture = useEditor((s) => s.gesture);
  if (!hoverId || selection.includes(hoverId) || gesture.active) return null;
  const m = measure(hoverId);
  if (!m) return null;
  return <Outline box={m.box} className="is-hover" />;
}

const CORNERS: HandleId[] = ['nw', 'ne', 'se', 'sw'];
const EDGES: HandleId[] = ['n', 'e', 's', 'w'];

const PADDING_TITLES = {
  top: msg('Padding top {value}'),
  right: msg('Padding right {value}'),
  bottom: msg('Padding bottom {value}'),
  left: msg('Padding left {value}'),
} as const;

function GapPaddingHandles({ id, box }: { id: string; box: LocalBox }) {
  const t = useT();
  const { snap } = session();
  const n = snap.nodes.get(id);
  const el = elOf(id);
  if (!n || !el) return null;
  const flow = flowOf(id);
  if (flow.kind !== 'flow' || box.rot !== 0) return null;
  const z = camera.value.z;
  const pad = paddingOf(n.style);
  const w = box.w * z;
  const h = box.h * z;
  const min = 6;
  const zones: { side: 'top' | 'right' | 'bottom' | 'left'; style: CSSProperties; value: number }[] = [
    { side: 'top', value: pad.top, style: { left: pad.left * z, right: pad.right * z, top: 0, height: Math.max(min, pad.top * z) } },
    { side: 'bottom', value: pad.bottom, style: { left: pad.left * z, right: pad.right * z, bottom: 0, height: Math.max(min, pad.bottom * z) } },
    { side: 'left', value: pad.left, style: { top: pad.top * z, bottom: pad.bottom * z, left: 0, width: Math.max(min, pad.left * z) } },
    { side: 'right', value: pad.right, style: { top: pad.top * z, bottom: pad.bottom * z, right: 0, width: Math.max(min, pad.right * z) } },
  ];
  const kids = snap.children(id).filter((c) => isFlow(c) && !snap.nodes.get(c)?.hidden);
  const rects = kids.flatMap((c) => rectOf(c) ?? []);
  const gaps: CSSProperties[] = [];
  for (let i = 0; i + 1 < rects.length; i++) {
    const a = rects[i]!;
    const b = rects[i + 1]!;
    if (flow.axis === 'x' && b.x >= a.x + a.w - 0.5) gaps.push({ left: (a.x + a.w - box.x) * z, top: pad.top * z, width: Math.max(4, (b.x - a.x - a.w) * z), bottom: pad.bottom * z, cursor: 'ew-resize' });
    if (flow.axis === 'y' && b.y >= a.y + a.h - 0.5) gaps.push({ top: (a.y + a.h - box.y) * z, left: pad.left * z, height: Math.max(4, (b.y - a.y - a.h) * z), right: pad.right * z, cursor: 'ns-resize' });
  }
  if (w < 48 || h < 32) return null;
  return (
    <>
      {zones.map((zone) => (
        <div key={zone.side} className={`ov-pad ov-pad-${zone.side}`} data-padding={zone.side} style={zone.style} title={t(PADDING_TITLES[zone.side], { value: fmt(zone.value) })}>
          <span />
        </div>
      ))}
      {gaps.map((style, i) => <div key={i} className={`ov-gap ov-gap-${flow.axis}`} data-gap="1" style={style} title={t('Gap')}><span /></div>)}
    </>
  );
}

function SelectionLayer() {
  const t = useT();
  useFrame();
  const selection = useEditor((s) => s.selection);
  const gesture = useEditor((s) => s.gesture);
  const editingText = useEditor((s) => s.editingTextId);
  const editingPath = useEditor((s) => s.editingPathId);
  const tool = useEditor((s) => s.tool);
  // Crop mode draws its own box and handles over the layer.
  const cropping = useUi((s) => s.crop !== null);
  if (!selection.length || cropping) return null;
  if (editingText) {
    const m = measure(editingText);
    return m ? <Outline box={m.box} className="is-editing" /> : null;
  }
  const { snap } = session();
  if (selection.length > 400) {
    const u = unionRects(selection.flatMap((id) => rectOf(id) ?? []));
    return u ? <Outline box={{ ...u, rot: 0 }} /> : null;
  }
  const measured = selection.flatMap((id) => measure(id) ?? []);
  if (!measured.length) return null;
  const single = measured.length === 1 ? measured[0]! : null;
  const box: LocalBox = single ? single.box : { ...unionRects(measured.map((m) => m.rect))!, rot: 0 };
  const z = camera.value.z;
  const hidden = gesture.active === 'move';
  const locked = selection.every((id) => snap.isLocked(id));
  const showHandles = !hidden && !gesture.active && tool === 'move' && !editingPath && !locked;
  const w = box.w * z;
  const h = box.h * z;
  const frameStyle: CSSProperties = { width: w, height: h, transform: `translate(${sx(box.x)}px, ${sy(box.y)}px) rotate(${box.rot}deg)` };
  const sizeText = single ? `${fmt(single.box.w)} × ${fmt(single.box.h)}` : t.n(measured.length, '{count} layer', '{count} layers');
  const bottom = apply(rotation(box.rot), { x: 0, y: h / 2 + 18 });
  const cxs = sx(box.x) + w / 2;
  const cys = sy(box.y) + h / 2;
  return (
    <>
      {!single ? measured.map((m) => <Outline key={m.id} box={m.box} className="is-member" />) : null}
      <div className={`ov-selection${locked ? ' is-locked' : ''}`} style={frameStyle} data-testid="selection-box">
        {single && showHandles ? <GapPaddingHandles id={single.id} box={box} /> : null}
        {showHandles ? (
          <>
            {EDGES.map((hd) => <div key={hd} className={`ov-edge ov-edge-${hd}`} data-handle={hd} style={{ cursor: handleCursor(hd, box.rot) }} />)}
            {CORNERS.map((hd) => <div key={`r${hd}`} className={`ov-rotate-zone ov-rotate-${hd}`} data-rotate="1" />)}
            {CORNERS.map((hd) => <div key={hd} className={`ov-handle ov-handle-${hd}`} data-handle={hd} style={{ cursor: handleCursor(hd, box.rot) }} />)}
            <div className="ov-rotate-stem" />
            <div className="ov-rotate-handle" data-rotate="1" title={t('Rotate. Hold shift for 15 degree steps.')} />
          </>
        ) : null}
      </div>
      {!gesture.active && !gesture.label ? (
        <div className="ov-size" style={{ left: cxs + bottom.x, top: cys + bottom.y }}>{sizeText}</div>
      ) : null}
    </>
  );
}

function MeasureLayer() {
  useFrame();
  const alt = useEditor((s) => s.altDown);
  const selection = useEditor((s) => s.selection);
  const hoverId = useEditor((s) => s.hoverId);
  const gesture = useEditor((s) => s.gesture);
  if (!alt || !selection.length || gesture.active) return null;
  const { snap } = session();
  const a = unionRects(selection.flatMap((id) => rectOf(id) ?? []));
  if (!a) return null;
  let otherId = hoverId && !selection.includes(hoverId) ? hoverId : null;
  if (!otherId) {
    const p = snap.nodes.get(selection[0]!)?.parent;
    if (p && snap.nodes.has(p)) otherId = p;
  }
  const b = otherId ? rectOf(otherId) : null;
  if (!b) return null;
  const lines = measureBetween(a, b);
  return (
    <>
      <div className="ov-outline is-measure" style={{ ...screenRect(b) }} />
      {lines.map((l, i) => {
        const horizontal = l.axis === 'x';
        const x0 = sx(Math.min(l.from.x, l.to.x));
        const y0 = sy(Math.min(l.from.y, l.to.y));
        const len = l.distance * camera.value.z;
        return (
          <div key={i}>
            <div className={`ov-measure ${horizontal ? 'is-h' : 'is-v'}`} style={horizontal ? { left: x0, top: y0, width: len } : { left: x0, top: y0, height: len }} />
            <div className="ov-measure-label" style={horizontal ? { left: x0 + len / 2, top: y0 + 6 } : { left: x0 + 6, top: y0 + len / 2 }}>{fmt(l.distance)}</div>
          </div>
        );
      })}
    </>
  );
}

function GestureLayer() {
  useFrame();
  const g = useEditor((s) => s.gesture);
  const z = camera.value.z;
  return (
    <>
      {g.marquee ? <div className="ov-marquee" style={screenRect(g.marquee)} /> : null}
      {g.zoomBox ? <div className="ov-marquee" style={screenRect(g.zoomBox)} /> : null}
      {g.drawing ? <div className="ov-drawing" style={screenRect(g.drawing)} /> : null}
      {g.drop?.container ? <div className="ov-drop-container" style={screenRect(g.drop.container)} /> : null}
      {g.drop?.line ? (
        <div className="ov-drop-line" style={g.drop.line.x0 === g.drop.line.x1
          ? { left: sx(g.drop.line.x0) - 1, top: sy(g.drop.line.y0), width: 2, height: (g.drop.line.y1 - g.drop.line.y0) * z }
          : { left: sx(g.drop.line.x0), top: sy(g.drop.line.y0) - 1, height: 2, width: (g.drop.line.x1 - g.drop.line.x0) * z }} data-testid="drop-line" />
      ) : null}
      {g.guides?.map((gd, i) => (
        <div key={i} className="ov-guide" style={gd.axis === 'x'
          ? { left: sx(gd.at), top: sy(gd.from), width: 1, height: (gd.to - gd.from) * z }
          : { left: sx(gd.from), top: sy(gd.at), height: 1, width: (gd.to - gd.from) * z }} />
      ))}
      {g.gaps?.map((gm, i) => (
        <div key={i}>
          <div className={`ov-gapmark ${gm.axis === 'x' ? 'is-h' : 'is-v'}`} style={gm.axis === 'x'
            ? { left: sx(gm.from), top: sy(gm.cross), width: gm.size * z }
            : { left: sx(gm.cross), top: sy(gm.from), height: gm.size * z }} />
          <div className="ov-measure-label is-gap" style={gm.axis === 'x'
            ? { left: sx(gm.from) + (gm.size * z) / 2, top: sy(gm.cross) + 6 }
            : { left: sx(gm.cross) + 6, top: sy(gm.from) + (gm.size * z) / 2 }}>{fmt(gm.size)}</div>
        </div>
      ))}
      {g.linePreview || g.pencil ? (
        <svg className="ov-svg">
          <g transform={`translate(${camera.value.x} ${camera.value.y}) scale(${z})`}>
            {g.linePreview ? <line x1={g.linePreview.x0} y1={g.linePreview.y0} x2={g.linePreview.x1} y2={g.linePreview.y1} className="ov-stroke" vectorEffect="non-scaling-stroke" /> : null}
            {g.pencil ? <path d={g.pencil} className="ov-stroke" vectorEffect="non-scaling-stroke" fill="none" /> : null}
          </g>
        </svg>
      ) : null}
      {g.label ? <div className="ov-size" style={{ left: sx(g.label.x), top: sy(g.label.y) + 12 }}>{g.label.text}</div> : null}
    </>
  );
}

function PenOverlay() {
  useFrame();
  const points = usePen((s) => s.points);
  const hover = usePen((s) => s.hover);
  const closing = usePen((s) => s.closingHover);
  if (!points.length) return null;
  const c = camera.value;
  const d = pathToD([{ points, closed: false }]);
  const last = points.at(-1)!;
  const preview = hover ? pathToD([{ points: [last, closing ? points[0]! : { x: hover.x, y: hover.y }], closed: false }]) : '';
  return (
    <>
      <svg className="ov-svg">
        <g transform={`translate(${c.x} ${c.y}) scale(${c.z})`}>
          <path d={d} className="ov-stroke" vectorEffect="non-scaling-stroke" fill="none" />
          {preview ? <path d={preview} className="ov-stroke is-preview" vectorEffect="non-scaling-stroke" fill="none" /> : null}
        </g>
        {last.hx2 !== undefined ? (
          <>
            <line x1={sx(last.hx1!)} y1={sy(last.hy1!)} x2={sx(last.hx2)} y2={sy(last.hy2!)} className="ov-handle-line" />
            <circle cx={sx(last.hx1!)} cy={sy(last.hy1!)} r={3} className="ov-handle-dot" />
            <circle cx={sx(last.hx2)} cy={sy(last.hy2!)} r={3} className="ov-handle-dot" />
          </>
        ) : null}
      </svg>
      {points.map((p, i) => (
        <div key={i} className={`ov-node${i === 0 && closing ? ' is-closing' : ''}`} style={{ left: sx(p.x), top: sy(p.y) }} />
      ))}
    </>
  );
}

function PathEditOverlay() {
  useFrame();
  const edit = usePathEdit((s) => s.edit);
  if (!edit) return null;
  const m = measureRaw(edit.id);
  if (!m) return null;
  const r = rotation(m.box.rot);
  const cx = m.box.x + m.box.w / 2;
  const cy = m.box.y + m.box.h / 2;
  const toScreen = (x: number, y: number): Vec => {
    const q = apply(r, { x: x - m.box.w / 2, y: y - m.box.h / 2 });
    return { x: sx(q.x + cx), y: sy(q.y + cy) };
  };
  const nodes: { key: string; p: PathPoint; id: string; selected: boolean }[] = [];
  edit.paths.forEach((subs, pi) => subs.forEach((sub, si) => sub.points.forEach((p, i) => {
    nodes.push({ key: `${pi}-${si}-${i}`, p, id: `${pi},${si},${i}`, selected: edit.selected?.path === pi && edit.selected.sub === si && edit.selected.point === i });
  })));
  return (
    <>
      <svg className="ov-svg">
        {nodes.map(({ key, p }) => {
          const a = toScreen(p.x, p.y);
          return (
            <g key={key}>
              {p.hx1 !== undefined ? (() => { const h = toScreen(p.hx1, p.hy1!); return <line x1={a.x} y1={a.y} x2={h.x} y2={h.y} className="ov-handle-line" />; })() : null}
              {p.hx2 !== undefined ? (() => { const h = toScreen(p.hx2, p.hy2!); return <line x1={a.x} y1={a.y} x2={h.x} y2={h.y} className="ov-handle-line" />; })() : null}
            </g>
          );
        })}
      </svg>
      {nodes.map(({ key, p, id }) => (
        <div key={`h${key}`}>
          {p.hx1 !== undefined ? (() => { const h = toScreen(p.hx1, p.hy1!); return <div className="ov-curve-handle" data-path-handle={`${id},1`} style={{ left: h.x, top: h.y }} />; })() : null}
          {p.hx2 !== undefined ? (() => { const h = toScreen(p.hx2, p.hy2!); return <div className="ov-curve-handle" data-path-handle={`${id},2`} style={{ left: h.x, top: h.y }} />; })() : null}
        </div>
      ))}
      {nodes.map(({ key, p, id, selected }) => {
        const a = toScreen(p.x, p.y);
        return <div key={key} className={`ov-node is-active${selected ? ' is-selected' : ''}`} data-path-point={id} style={{ left: a.x, top: a.y }} />;
      })}
    </>
  );
}

const PeerCursor = memo(function PeerCursor({ name, color, x, y, chat, agent, working }: { name: string; color: string; x: number; y: number; chat?: string; agent?: boolean; working?: boolean }) {
  return (
    <div className={`ov-cursor${agent ? ' is-agent' : ''}`} style={anchored(x, y)}>
      <svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 1.5 14 7l-5.2 1.6L6.7 14 2 1.5Z" fill={color} stroke="#fff" strokeWidth="1" strokeLinejoin="round" /></svg>
      <div className="ov-cursor-name" dir="auto" style={{ background: color, color: readableOn(color) }}>
        {name}{working ? <span className="ov-cursor-working" /> : null}
      </div>
      {chat ? <div className="ov-cursor-chat" dir="auto" style={{ background: color, color: readableOn(color) }}>{chat}</div> : null}
    </div>
  );
});

function PeersLayer() {
  // The outlines of people and working agents are anchored in world coordinates: they follow a pan, a zoom or a fit
  // through CSS, so this re-renders only when layers change, not on every camera move.
  useLayerFrame();
  const peers = useEditor((s) => s.peers);
  const pageId = useEditor((s) => s.pageId);
  const agents = useEditor((s) => s.activeAgents);
  const here = peers.filter((p) => p.pageId === pageId);
  const agentNodes = Object.entries(agents).flatMap(([name, a]) => a.nodeIds.map((id) => ({ name, id })));
  return (
    <>
      {here.flatMap((p) => p.selection.slice(0, 50).flatMap((id) => {
        const m = measure(id);
        return m ? [<AnchoredOutline key={`${p.clientId}-${id}`} box={m.box} className={p.user.agent ? 'is-peer is-working' : 'is-peer'} color={p.user.color} testId="peer-outline" />] : [];
      }))}
      {agentNodes.map(({ name, id }) => {
        const m = measure(id);
        return m ? <AnchoredOutline key={`a-${name}-${id}`} box={m.box} className="is-working" testId="agent-outline" /> : null;
      })}
      {here.map((p) => (p.cursor && p.cursor.pageId === pageId ? (
        <PeerCursor key={p.clientId} name={p.user.name} color={p.user.color} x={p.cursor.x} y={p.cursor.y} chat={p.chat} agent={p.user.agent} working={Boolean(agents[p.user.name])} />
      ) : null))}
    </>
  );
}

function CommentPins() {
  const comments = useComments();
  const pageId = useEditor((s) => s.pageId);
  const active = useEditor((s) => s.activeThreadId);
  useFrameVersion();
  useFrameTickOnly();
  const list = useMemo(() => comments.filter((c) => c.pageId === pageId && !c.resolved), [comments, pageId]);
  return (
    <>
      {list.map((t, i) => {
        const r = t.nodeId ? rectOf(t.nodeId) : null;
        if (t.nodeId && !r) return null;
        const x = (r?.x ?? 0) + t.x;
        const y = (r?.y ?? 0) + t.y;
        const author = t.messages[0]?.author ?? '?';
        return (
          <div key={t.id} className={`ov-pin${active === t.id ? ' is-active' : ''}`} style={anchored(x, y)} data-pin={t.id} data-count={t.messages.length} title={t.messages[0]?.text}>
            <span data-pin={t.id}>{author.trim()[0]?.toUpperCase() ?? String(i + 1)}</span>
          </div>
        );
      })}
    </>
  );
}

function CommentComposer() {
  const t = useT();
  const pending = useEditor((s) => s.pendingComment);
  const pageId = useEditor((s) => s.pageId);
  const [text, setText] = useState('');
  useFrame();
  if (!pending || !pageId) return null;
  const r = pending.nodeId ? rectOf(pending.nodeId) : null;
  const x = (r?.x ?? 0) + pending.x;
  const y = (r?.y ?? 0) + pending.y;
  const s = session();
  const submit = async (body: string, files: CommentAttachment[]) => {
    const where = { pageId, ...(pending.nodeId ? { nodeId: pending.nodeId } : {}), x: pending.x, y: pending.y };
    const id = agentMentions(body).length ? await askAgentInComment(body, where, files) : s.doc.addThread({ ...where, author: s.user.name, text: body, attachments: files });
    editor().set({ pendingComment: null, activeThreadId: id, rightTab: 'comments' });
  };
  return (
    <div className="ov-composer" data-ui style={{ left: sx(x) + 12, top: sy(y) - 8 }}>
      <CommentInput autoFocus rows={2} placeholder={t('Add a comment. @claude or @codex asks that agent. Enter sends.')} testId="comment-input" onText={setText} onSubmit={submit} onCancel={() => editor().set({ pendingComment: null })} />
      <CommentRunChoice text={text} />
    </div>
  );
}

function CursorChat() {
  const t = useT();
  const chat = useEditor((s) => s.cursorChat);
  const inputRef = useRef<HTMLInputElement>(null);
  const clearTimer = useRef(0);
  useEffect(() => {
    if (chat.open) inputRef.current?.focus();
  }, [chat.open]);
  if (!chat.open) return null;
  const p = lastPointerPos();
  const close = () => {
    editor().set({ cursorChat: { open: false, text: '' } });
    clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(() => setCursorChat(undefined), 4000);
  };
  return (
    <div className="ov-chat" data-ui style={{ left: p.x - camera.left + 14, top: p.y - camera.top + 14 }}>
      <input
        ref={inputRef}
        value={chat.text}
        dir="auto"
        placeholder={t('Say something')}
        maxLength={160}
        onChange={(e) => {
          editor().set({ cursorChat: { open: true, text: e.target.value } });
          clearTimeout(clearTimer.current);
          setCursorChat(e.target.value);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Escape') close();
        }}
        onBlur={close}
      />
    </div>
  );
}

function EmptyHint() {
  const pageId = useEditor((s) => s.pageId);
  return pageId ? <EmptyHintOn pageId={pageId} /> : null;
}

function EmptyHintOn({ pageId }: { pageId: string }) {
  const t = useT();
  const kids = useChildren(pageId);
  const tool = useEditor((s) => s.tool);
  if (kids.length || tool !== 'move') return null;
  return (
    <div className="ov-empty">
      <div>{t('This page is empty.')}</div>
      <div className="ov-empty-sub">{t('Press {frameKey} for a frame, {textKey} for text, or paste HTML, SVG or an image. {askKey} asks your agent.', { frameKey: 'F', textKey: 'T', askKey: 'Ctrl+K' })}</div>
    </div>
  );
}

export function Overlay({ rootRef, previewRef }: { rootRef: RefObject<HTMLDivElement | null>; previewRef?: (el: HTMLDivElement | null) => void }) {
  return (
    <div ref={rootRef} className="overlay">
      <div ref={previewRef} data-testid="screen-paint-layer" aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: 0, height: 0, transformOrigin: '0 0', transform: 'translate(calc(var(--cx) * 1px), calc(var(--cy) * 1px)) scale(var(--z))', pointerEvents: 'none' }} />
      <PixelGrid />
      <EmptyHint />
      <LayoutGridsLayer />
      <CanvasSections />
      <FrameLabels />
      <PeersLayer />
      <HoverOutline />
      <MeasureLayer />
      <FindHighlights />
      <SelectionLayer />
      <SpacingHandles />
      <GradientHandles />
      <CropHandles />
      <PathEditOverlay />
      <PenOverlay />
      <GestureLayer />
      <CommentPins />
      <DriftOverlay />
      <BrandMarkers />
      <CommentComposer />
      <CursorChat />
    </div>
  );
}

export { computedBox, topLevelOf };
