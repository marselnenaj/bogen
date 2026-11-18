import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
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
import { NAME_ZOOM, NAMES_MIN_Z, placeWords, routeFlows, ScreenIndex, SIZES, type FlowRoute, type Placement } from './flow-layout.ts';

const at = (r: CanvasBox) => ({ '--wx': r.x, '--wy': r.y, '--ww': r.w, '--wh': r.h } as CSSProperties);
const flowKey = (c: { from: string; to: string }) => `${c.from}>${c.to}`;

/** The last placement and routing passes, in milliseconds, for tests that measure what a frame of zooming costs. */
const times: number[] = []; const routeTimes: number[] = [];
if (typeof window !== 'undefined') (window as unknown as { __bogenFlows?: unknown }).__bogenFlows = { times, routeTimes };

/** Widths of text in the overlay's own fonts, measured once per text. */
const widths = new Map<string, number>();
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  const key = `${font}\n${text}`;
  const known = widths.get(key);
  if (known !== undefined) return known;
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  const w = Math.ceil(measureCtx.measureText(text).width) + 1;
  widths.set(key, w);
  return w;
}
function fontOf(el: Element | null | undefined, size?: string): string {
  if (!el) return '12px sans-serif';
  const s = getComputedStyle(el);
  return `${s.fontStyle} ${s.fontWeight} ${size ?? s.fontSize} ${s.fontFamily}`;
}

/** Organization belongs to the editing canvas; never insert headings or arrows into exported screens. */
export function CanvasSections() {
  const t = useT(); const page = useEditor(s => s.pageId); const { doc } = session();
  const version = useFrameVersion(); const [tick, setTick] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const placed = useRef<Placement | undefined>(undefined);
  useEffect(() => {
    const update = () => { if (page && (doc.meta.has(`canvasPlan:${page}`) || doc.getChildren(page).filter(n => n.artboard && !n.hidden).length >= 3)) setTick(v => v + 1); };
    const frame = requestAnimationFrame(update);
    const off = onOverlayTick(update);
    return () => { cancelAnimationFrame(frame); off(); };
  }, [doc, page]);
  // Routes depend on where the screens stand, never on the zoom: worked out again only when the screens move. They
  // keep clear of the screens' names and the sections' titles as large as these stand at NAME_ZOOM, the farthest zoom
  // names show at, so one set of routes serves every zoom.
  const routed = useRef<{ key: string; routes: FlowRoute[] }>({ key: '', routes: [] });
  const data = useMemo(() => {
    const plan = page ? readCanvasPlan(doc, page) : null;
    const boards = page ? doc.getChildren(page).filter(n => n.artboard && !n.hidden) : [];
    const boxes = new Map<string, CanvasBox>();
    for (const n of boards) { const r = rectOf(n.id); if (r && r.w > 0 && r.h > 0) boxes.set(n.id, r); }
    const box = (id: string) => boxes.get(id) ?? null;
    const sections = (plan?.sections ?? []).flatMap(s => {
      const lanes = s.lanes.flatMap(l => { const r = unionCanvasBoxes(l.node_ids.flatMap(id => box(id) ?? [])); return r ? [{ ...l, box: r }] : []; });
      const r = unionCanvasBoxes(lanes.map(l => l.box));
      return [{ ...s, lanes, box: r ? { x: r.x - 64, y: r.y - 140, w: r.w + 128, h: r.h + 204 } : null }];
    });
    const connections = (plan?.connections ?? []).filter(c => boxes.has(c.from) && boxes.has(c.to));
    // The fonts are known once the names and titles are on the page.
    const font = fontOf(document.querySelector('.ov-frame-label')); const titleFont = fontOf(document.querySelector('.canvas-section-title strong'));
    const key = JSON.stringify([font, titleFont, connections, sections.map(s => [s.title, s.box]), [...boxes].map(([id, b]) => [id, b.x, b.y, b.w, b.h])]);
    if (routed.current.key !== key) {
      const z = NAME_ZOOM;
      const names = new Map(boards.flatMap(n => { const b = boxes.get(n.id); return b ? [[b, b.x + Math.min(textWidth(n.name, font) + 2 * SIZES.namePad, b.w * z) / z] as const] : []; }));
      const titleHeight = (SIZES.titlePad + SIZES.titleLine) / z;
      const titles = sections.flatMap(s => s.box ? [{ x: s.box.x, y: s.box.y - titleHeight, w: textWidth(s.title, titleFont) / z, h: titleHeight }] : []);
      const t0 = performance.now();
      routed.current = { key, routes: routeFlows(connections, boxes, [...boxes.values()], { frames: sections.flatMap(s => s.box ?? []), names, titles, nameZoom: z, zoom: z }) };
      routeTimes.push(performance.now() - t0); if (routeTimes.length > 60) routeTimes.shift();
    }
    const assigned = new Set((plan?.sections ?? []).flatMap(s => s.lanes.flatMap(l => l.node_ids)));
    const sectionOf = new Map((plan?.sections ?? []).flatMap(s => s.lanes.flatMap(l => l.node_ids.map(id => [id, s.id] as const))));
    const unassigned = boards.filter(n => !assigned.has(n.id)).map(n => ({ id: n.id, name: n.name, box: box(n.id) }));
    const screens = boards.flatMap(n => { const b = box(n.id); return b ? [{ id: n.id, name: n.name, box: b }] : []; });
    return { sections, routes: routed.current.routes, unassigned, screens, sectionOf };
  }, [doc, page, version, tick]);

  // Where the words stand is decided again whenever the zoom changes; panning moves everything together in CSS.
  useLayoutEffect(() => {
    const el = root.current?.parentElement;
    if (!el) return;
    const q = <T extends Element>(sel: string) => el.querySelector<T>(sel);
    const sectionEl = q('.canvas-section-title strong'); const purposeEl = q('.canvas-section-title span');
    const laneEl = q('.canvas-lane-title span'); const labelEl = q('.canvas-flow-label'); const nameEl = el.querySelector('.ov-frame-label') ?? laneEl;
    const titleFont = fontOf(sectionEl); const compactFont = fontOf(sectionEl, '12px'); const purposeFont = fontOf(purposeEl);
    const laneFont = fontOf(laneEl); const labelFont = fontOf(labelEl); const nameFont = fontOf(nameEl);
    const index = new ScreenIndex(data.screens.map(s => ({ box: s.box, nameWidth: textWidth(s.name, nameFont) })));
    const sections = data.sections.flatMap(s => s.box ? [{ id: s.id, box: s.box, top: Math.min(...s.lanes.map(l => l.box.y)), titleWidth: textWidth(s.title, titleFont), purposeWidth: textWidth(s.purpose, purposeFont), compactWidth: textWidth(s.title, compactFont) }] : []);
    const lanes = data.sections.flatMap(s => s.lanes.map((l, i) => ({ key: `${s.id}-${i}`, section: s.id, box: l.box, width: textWidth(l.title, laneFont) + 8 })));
    const space = textWidth('a a', labelFont) - 2 * textWidth('a', labelFont);
    const labels = data.routes.map(r => ({ key: flowKey(r), route: r.points, words: r.label.split(/\s+/).filter(Boolean).map(w => textWidth(w, labelFont)), space, width: 0 }));
    const nodes = new Map<string, HTMLElement>();
    for (const n of el.querySelectorAll<HTMLElement>('[data-flow-word]')) nodes.set(n.dataset.flowWord!, n);
    let lastZ = 0; let frame = 0;
    const place = () => {
      frame = 0;
      const z = camera.value.z;
      if (z === lastZ) return;
      lastZ = z;
      const t0 = performance.now();
      const next = placeWords(z, index, sections, lanes, labels, placed.current);
      for (const [id, { lod, grow, wide }] of next.sections) {
        const n = nodes.get(`section:${id}`); if (n && n.dataset.lod !== lod) n.dataset.lod = lod;
        if (n) n.toggleAttribute('data-wide', wide);
        nodes.get(`frame:${id}`)?.style.setProperty('--grow', `${grow}px`);
      }
      // Far out, a plan page shows frames, titles and routes; the screens' names wait for room.
      const far = z < NAMES_MIN_Z && sections.length > 0;
      if (el.hasAttribute('data-flow-far') !== far) el.toggleAttribute('data-flow-far', far);
      for (const [key, shown] of next.lanes) { const n = nodes.get(`lane:${key}`); if (n) n.dataset.shown = shown ? '1' : '0'; }
      for (const r of data.routes) {
        const key = flowKey(r); const n = nodes.get(`label:${key}`); if (!n) continue;
        const p = next.labels.get(key);
        n.dataset.shown = p ? '1' : '0';
        if (!p) continue;
        n.style.setProperty('--wx', String(p.x)); n.style.setProperty('--wy', String(p.y));
        // Inside a frame the pill takes the frame's tint.
        n.toggleAttribute('data-inside', sections.some(s => p.x > s.box.x && p.x < s.box.x + s.box.w && p.y > s.box.y && p.y < s.box.y + s.box.h));
        const words = r.label.split(/\s+/).filter(Boolean); let i = 0;
        const text = p.lines.map(count => words.slice(i, (i += count)).join(' ')).join('\n');
        if (n.textContent !== text) n.textContent = text;
      }
      placed.current = next;
      times.push(performance.now() - t0);
      if (times.length > 240) times.shift();
    };
    place();
    const off = camera.subscribe(() => { if (!frame && camera.value.z !== lastZ) frame = requestAnimationFrame(place); });
    const fonts = () => { widths.clear(); lastZ = 0; place(); };
    document.fonts?.addEventListener('loadingdone', fonts);
    return () => { off(); cancelAnimationFrame(frame); document.fonts?.removeEventListener('loadingdone', fonts); el.removeAttribute('data-flow-far'); };
  }, [data]);

  if (!data.sections.length && data.unassigned.length < 3) return null;
  const focus = (box: CanvasBox | null) => { if (box) camera.fit(box); };
  /** A label that has no room shows while its line is hovered, on top of everything. */
  const hover = (key: string, on: boolean) => {
    const el = root.current?.parentElement;
    el?.querySelector(`[data-flow-word="label:${CSS.escape(key)}"]`)?.classList.toggle('is-hover', on);
    el?.querySelector(`[data-flow-line="${CSS.escape(key)}"]`)?.classList.toggle('is-hover', on);
  };
  return <>
    <div ref={root} hidden />
    {/* Lines first: titles, names and labels stand on top of them, on their own backing. */}
    <svg className="canvas-connections" aria-hidden="true">
      <g style={{ transform: 'translate(calc(var(--cx) * 1px), calc(var(--cy) * 1px)) scale(var(--z))', transformOrigin: '0 0' }}>
        {data.routes.map(r => {
          const key = flowKey(r);
          return <g key={key} className="canvas-flow" data-within={data.sectionOf.get(r.from) !== undefined && data.sectionOf.get(r.from) === data.sectionOf.get(r.to) ? '' : undefined}>
            <path className="canvas-flow-hit" d={r.d} onPointerEnter={() => hover(key, true)} onPointerLeave={() => hover(key, false)} />
            <path className="canvas-flow-line" data-route data-from={r.from} data-to={r.to} data-flow-line={key} d={r.d} vectorEffect="non-scaling-stroke" />
            <path className="canvas-flow-head" d="M-1.5,0 L-9.5,-4 L-9.5,4 Z" style={{ transform: `translate(${r.tip.x}px, ${r.tip.y}px) rotate(${r.tip.angle}deg) scale(var(--flow-head))` }} />
          </g>;
        })}
      </g>
    </svg>
    {data.sections.flatMap(s => s.box ? [<div key={s.id} className="canvas-section" style={at(s.box)} data-testid="canvas-section" data-section-id={s.id} data-flow-word={`frame:${s.id}`}>
      <button type="button" className="canvas-section-title" data-ui data-flow-word={`section:${s.id}`} data-lod="title" title={s.purpose} onPointerDown={e => e.stopPropagation()} onClick={() => focus(s.box)}><strong>{s.title}</strong><span>{s.purpose}</span></button>
    </div>] : [])}
    {data.sections.flatMap(s => s.lanes.map((l, i) => <div key={`${s.id}-${i}`} className="canvas-lane-title" style={at(l.box)} data-flow-word={`lane:${s.id}-${i}`} data-shown="0"><span>{l.title}</span></div>))}
    {data.routes.map(r => {
      // Until the placement says where, a label waits hidden on the middle of its longest stretch.
      const seg = r.points.slice(1).map((q, i) => ({ p: r.points[i]!, q })).sort((a, b) => Math.hypot(b.q.x - b.p.x, b.q.y - b.p.y) - Math.hypot(a.q.x - a.p.x, a.q.y - a.p.y))[0]!;
      return <div key={flowKey(r)} className="canvas-flow-label" data-flow-word={`label:${flowKey(r)}`} data-shown="0" style={{ '--wx': (seg.p.x + seg.q.x) / 2, '--wy': (seg.p.y + seg.q.y) / 2 } as CSSProperties}>{r.label}</div>;
    })}
    <details className="canvas-map" data-ui data-testid="canvas-map" onPointerDown={e => e.stopPropagation()}>
      <summary><MapIcon size={14} aria-hidden="true" />{t('Sections')}<span>{data.unassigned.length ? `${t('Unassigned screens')} · ${data.unassigned.length}` : data.sections.length}</span></summary>
      <nav aria-label={t('Canvas')}>{data.sections.map(s => <button type="button" key={s.id} onClick={e => { focus(s.box); const map = e.currentTarget.closest('details'); if (map) { map.open = false; map.querySelector('summary')?.focus(); } }} data-testid="canvas-section-focus" data-section-id={s.id} disabled={!s.box}><strong>{s.title}</strong><span>{s.purpose}</span></button>)}{data.unassigned.length > 0 && <><strong className="canvas-map-unassigned">{t('Unassigned screens')} · {data.unassigned.length}</strong>{data.unassigned.map(n => <button type="button" key={n.id} disabled={!n.box} onClick={e => { prepareLayerMeasurements([n.id]); focus(n.box); const map = e.currentTarget.closest('details'); if (map) map.open = false; }}><span>{n.name}</span></button>)}</>}</nav>
    </details>
  </>;
}
