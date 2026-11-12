import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import { Map as MapIcon } from 'lucide-react';
import { readCanvasPlan, unionCanvasBoxes, type CanvasBox } from '@bogen/core';
import { useFrameVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { camera } from '../state/camera.ts';
import { useEditor } from '../state/store.ts';
import { useT } from '../i18n/react.ts';
import { rectOf } from './measure.ts';
import { onOverlayTick } from './overlay-tick.ts';
import { prepareLayerMeasurements } from './artboard-loading.ts';

const at = (r: CanvasBox) => ({ '--wx': r.x, '--wy': r.y, '--ww': r.w, '--wh': r.h } as CSSProperties);

/** Organization belongs to the editing canvas; never insert headings or arrows into exported screens. */
export function CanvasSections() {
  const t = useT(); const page = useEditor(s => s.pageId); const { doc } = session();
  const version = useFrameVersion(); const [tick, setTick] = useState(0);
  useEffect(() => {
    const update = () => { if (page && (doc.meta.has(`canvasPlan:${page}`) || doc.getChildren(page).filter(n => n.artboard && !n.hidden).length >= 3)) setTick(v => v + 1); };
    const frame = requestAnimationFrame(update);
    const off = onOverlayTick(update);
    return () => { cancelAnimationFrame(frame); off(); };
  }, [doc, page]);
  const arrow = `canvas-arrow-${useId().replace(/:/g, '')}`;
  const data = useMemo(() => {
    const plan = page ? readCanvasPlan(doc, page) : null;
    const boxes = new Map<string, CanvasBox>();
    const box = (id: string) => {
      if (boxes.has(id)) return boxes.get(id)!;
      const n = doc.getNode(id);
      if (!n || n.parent !== page || n.hidden) return null;
      const r = rectOf(id);
      if (r && r.w > 0 && r.h > 0) { boxes.set(id, r); return r; }
      return null;
    };
    const sections = (plan?.sections ?? []).flatMap(s => {
      const lanes = s.lanes.flatMap(l => { const r = unionCanvasBoxes(l.node_ids.flatMap(id => box(id) ?? [])); return r ? [{ ...l, box: r }] : []; });
      const r = unionCanvasBoxes(lanes.map(l => l.box));
      return [{ ...s, lanes, box: r ? { x: r.x - 64, y: r.y - 140, w: r.w + 128, h: r.h + 204 } : null }];
    });
    const connections = (plan?.connections ?? []).flatMap(c => {
      const a = box(c.from); const b = box(c.to); if (!a || !b) return [];
      const vertical = b.y >= a.y + a.h || a.y >= b.y + b.h;
      const down = b.y > a.y; const right = b.x > a.x;
      const from = vertical ? { x: a.x + a.w / 2, y: down ? a.y + a.h : a.y } : { x: right ? a.x + a.w : a.x, y: a.y + a.h / 2 };
      const to = vertical ? { x: b.x + b.w / 2, y: down ? b.y : b.y + b.h } : { x: right ? b.x : b.x + b.w, y: b.y + b.h / 2 };
      const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      const path = vertical ? `M${from.x},${from.y} C${from.x},${mid.y} ${to.x},${mid.y} ${to.x},${to.y}` : `M${from.x},${from.y} C${mid.x},${from.y} ${mid.x},${to.y} ${to.x},${to.y}`;
      return [{ ...c, path, mid }];
    });
    const assigned = new Set((plan?.sections ?? []).flatMap(s => s.lanes.flatMap(l => l.node_ids)));
    const unassigned = page ? doc.getChildren(page).filter(n => n.artboard && !n.hidden && !assigned.has(n.id)).map(n => ({ id: n.id, name: n.name, box: box(n.id) })) : [];
    return { sections, connections, unassigned };
  }, [doc, page, version, tick]);
  if (!data.sections.length && data.unassigned.length < 3) return null;
  const focus = (box: CanvasBox | null) => { if (box) camera.fit(box); };
  return <>
    {data.sections.flatMap(s => s.box ? [<div key={s.id} className="canvas-section" style={at(s.box)} data-testid="canvas-section" data-section-id={s.id}>
      <button type="button" className="canvas-section-title" data-ui title={s.purpose} onPointerDown={e => e.stopPropagation()} onClick={() => focus(s.box)}>{s.title}<span>{s.purpose}</span></button>
    </div>] : [])}
    {data.sections.flatMap(s => s.lanes.map((l, i) => <div key={`${s.id}-${i}`} className="canvas-lane-title" style={at(l.box)}>{l.title}</div>))}
    <svg className="canvas-connections" aria-hidden="true"><defs><marker id={arrow} markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0 L7 3.5 L0 7" fill="none" stroke="var(--ui-fg-2)" /></marker></defs>
      <g style={{ transform: 'translate(calc(var(--cx) * 1px), calc(var(--cy) * 1px)) scale(var(--z))', transformOrigin: '0 0' }}>
        {data.connections.map(c => <g key={`${c.from}:${c.to}`}><path d={c.path} fill="none" stroke="var(--ui-fg-2)" strokeWidth="1" vectorEffect="non-scaling-stroke" markerEnd={`url(#${arrow})`} /><text x={c.mid.x} y={c.mid.y - 8} textAnchor="middle">{c.label}</text></g>)}
      </g>
    </svg>
    <details className="canvas-map" data-ui data-testid="canvas-map" onPointerDown={e => e.stopPropagation()}>
      <summary><MapIcon size={14} aria-hidden="true" />{t('Canvas')}<span>{data.unassigned.length ? `${t('Unassigned screens')} · ${data.unassigned.length}` : data.sections.length}</span></summary>
      <nav aria-label={t('Canvas')}>{data.sections.map(s => <button type="button" key={s.id} onClick={e => { focus(s.box); const map = e.currentTarget.closest('details'); if (map) { map.open = false; map.querySelector('summary')?.focus(); } }} data-testid="canvas-section-focus" data-section-id={s.id} disabled={!s.box}><strong>{s.title}</strong><span>{s.purpose}</span></button>)}{data.unassigned.length > 0 && <><strong className="canvas-map-unassigned">{t('Unassigned screens')} · {data.unassigned.length}</strong>{data.unassigned.map(n => <button type="button" key={n.id} disabled={!n.box} onClick={e => { prepareLayerMeasurements([n.id]); focus(n.box); const map = e.currentTarget.closest('details'); if (map) map.open = false; }}><span>{n.name}</span></button>)}</>}</nav>
    </details>
  </>;
}
