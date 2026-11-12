import { useEffect, useState } from 'react';
import { session } from '../doc/session.ts';
import { camera } from '../state/camera.ts';
import { useUi } from '../state/ui.ts';
import { apply, rotation, type Vec } from './geometry.ts';
import { activeGradient } from './gradient-drag.ts';
import { linearPoint, parseRadial, radialPoint } from './gradient-geom.ts';
import { measure } from './measure.ts';
import { onOverlayTick, tickOverlay } from './overlay-tick.ts';
import { useT } from '../i18n/react.ts';

/** Handles for the linear or radial fill whose editor is open, drawn on the layer they belong to. */
export function GradientHandles() {
  const on = useUi((s) => s.gradient !== null);
  return on ? <Handles /> : null;
}

function Handles() {
  const t = useT();
  const active = useUi((s) => s.gradient?.stop ?? 0);
  const [, setN] = useState(0);
  useEffect(() => {
    const bump = () => setN((v) => v + 1);
    const a = camera.subscribe(bump);
    const b = onOverlayTick(bump);
    const c = session().snap.subscribe(tickOverlay);
    return () => { a(); b(); c(); };
  }, []);
  const g = activeGradient();
  if (!g) return null;
  const m = measure(g.node.id);
  if (!m) return null;
  const { x: cxw, y: cyw, w, h } = { x: m.box.x + m.box.w / 2, y: m.box.y + m.box.h / 2, w: g.w, h: g.h };
  const r = rotation(m.box.rot);
  const z = camera.value.z;
  const toScreen = (p: Vec): Vec => {
    const q = apply(r, { x: p.x - w / 2, y: p.y - h / 2 });
    return { x: (q.x + cxw) * z + camera.value.x, y: (q.y + cyw) * z + camera.value.y };
  };
  const stops = g.fill.stops;
  const isLinear = g.fill.kind === 'linear';
  const fill = g.fill;
  const shape = fill.kind === 'radial' ? parseRadial(fill.shape, w, h) : null;
  const point = (at: number) => (fill.kind === 'linear' ? linearPoint(fill.angle, w, h, at) : radialPoint(shape!, at));
  const lo = isLinear ? Math.min(...stops.map((s) => s.at)) : 0;
  const hi = isLinear ? Math.max(...stops.map((s) => s.at)) : 100;
  const a = toScreen(point(lo));
  const b = toScreen(point(hi));
  return (
    <div className="ov-gradient" data-keep-popover data-testid="gradient-handles">
      <svg className="ov-svg">
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="ov-gradient-under" />
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="ov-gradient-line" />
        <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="ov-gradient-hit" data-gradient="line" data-testid="gradient-line" />
        {shape?.kind === 'ellipse' ? (() => {
          const c = toScreen({ x: shape.cx, y: shape.cy });
          const ry = toScreen({ x: shape.cx, y: shape.cy + shape.ry });
          return (
            <>
              <line x1={c.x} y1={c.y} x2={ry.x} y2={ry.y} className="ov-gradient-under" />
              <line x1={c.x} y1={c.y} x2={ry.x} y2={ry.y} className="ov-gradient-line" />
            </>
          );
        })() : null}
      </svg>
      {shape ? (() => {
        const c = toScreen({ x: shape.cx, y: shape.cy });
        return <div className="ov-gradient-center" data-gradient="center" data-testid="gradient-center" title={t('Centre')} style={{ left: c.x, top: c.y }} />;
      })() : null}
      {shape?.kind === 'ellipse' ? (() => {
        const p = toScreen({ x: shape.cx, y: shape.cy + shape.ry });
        return <div className="ov-gradient-radius" data-gradient="radius-y" data-testid="gradient-radius-y" title={t('Height of the ellipse')} style={{ left: p.x, top: p.y }} />;
      })() : null}
      {shape ? (() => {
        const p = toScreen(radialPoint(shape, 100));
        const hasEnd = stops.some((s) => s.at === 100);
        return hasEnd ? null : <div className="ov-gradient-radius" data-gradient="radius" data-testid="gradient-radius" title={t('Radius')} style={{ left: p.x, top: p.y }} />;
      })() : null}
      {stops.map((s, i) => {
        const p = toScreen(point(s.at));
        // In a radial gradient the outermost stop is also what sets the radius, and the first sits on the centre.
        const role = shape && s.at === 100 ? 'radius' : shape && s.at === 0 ? 'center' : 'stop';
        return (
          <div
            key={i}
            className={`ov-gradient-stop${i === active ? ' is-active' : ''}`}
            data-gradient={role}
            data-gradient-stop={i}
            data-testid="gradient-handle"
            title={t('Drag to move. {shortcut} or Delete removes it.', { shortcut: 'Alt+click' })}
            style={{ left: p.x, top: p.y }}
          >
            <span data-gradient={role} data-gradient-stop={i} style={{ background: s.color }} />
          </div>
        );
      })}
    </div>
  );
}
