import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { MOCKUP_ATTR, readMockupConfig, type Mesh, type Point } from '@bogen/core';
import { session } from '../doc/session.ts';
import { camera } from '../state/camera.ts';
import { useEditor } from '../state/store.ts';
import { isMockup, writeMockup } from '../panels/inspector/BrandApps.tsx';
import { measure } from './measure.ts';
import { onOverlayTick, tickOverlay } from './overlay-tick.ts';
import { useT } from '../i18n/react.ts';

/**
 * Corner handles on a selected mockup: drag one of the four corners of the surface to fit the print to the object
 * or the photo. Points between the corners of a cloth mesh follow in proportion, so a bag's curve keeps its shape.
 * One undo step per drag. The agents' mockup_place takes the same corners.
 */
export type Corner = 'tl' | 'tr' | 'br' | 'bl';
const CORNERS: Corner[] = ['tl', 'tr', 'br', 'bl'];

/** The mesh after one corner moved by (dx, dy), in the mockup's own pixels. Inner points follow in proportion. */
export function moveCorner(mesh: Mesh, corner: Corner, dx: number, dy: number): Mesh {
  const n = mesh.top.length - 1;
  const shift = (row: Point[], atStart: boolean) => row.map(([x, y], i) => {
    const w = n === 0 ? 1 : atStart ? 1 - i / n : i / n;
    return [x + dx * w, y + dy * w] as Point;
  });
  const top = corner === 'tl' ? shift(mesh.top, true) : corner === 'tr' ? shift(mesh.top, false) : mesh.top;
  const bottom = corner === 'bl' ? shift(mesh.bottom, true) : corner === 'br' ? shift(mesh.bottom, false) : mesh.bottom;
  return { top, bottom };
}

export function cornerPoint(mesh: Mesh, corner: Corner): Point {
  return corner === 'tl' ? mesh.top[0]! : corner === 'tr' ? mesh.top.at(-1)! : corner === 'br' ? mesh.bottom.at(-1)! : mesh.bottom[0]!;
}

export function MockupHandles() {
  const selection = useEditor((s) => s.selection);
  const id = selection.length === 1 ? selection[0]! : '';
  const node = id ? session().snap.nodes.get(id) : undefined;
  return node && isMockup(node) ? <Handles nodeId={id} /> : null;
}

function Handles({ nodeId }: { nodeId: string }) {
  const t = useT();
  const [, setN] = useState(0);
  const [draft, setDraft] = useState<Mesh | null>(null);
  const drag = useRef<{ corner: Corner; x: number; y: number; mesh: Mesh; k: number } | null>(null);
  useEffect(() => {
    const bump = () => setN((v) => v + 1);
    const a = camera.subscribe(bump);
    const b = onOverlayTick(bump);
    const c = session().snap.subscribe(tickOverlay);
    return () => { a(); b(); c(); };
  }, []);
  const node = session().snap.nodes.get(nodeId);
  const m = measure(nodeId);
  if (!node || !m) return null;
  const config = readMockupConfig(node.attrs?.[MOCKUP_ATTR]);
  if (!config) return null;
  const z = camera.value.z;
  // Screen pixels per pixel of the mockup.
  const k = (m.box.w / Math.max(1, config.width)) * z;
  const mesh = draft ?? config.mesh;
  const at = ([x, y]: Point) => ({ left: m.box.x * z + camera.value.x + x * k, top: m.box.y * z + camera.value.y + y * k });
  const begin = (corner: Corner) => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { corner, x: e.clientX, y: e.clientY, mesh: config.mesh, k };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    setDraft(moveCorner(d.mesh, d.corner, (e.clientX - d.x) / d.k, (e.clientY - d.y) / d.k));
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    const done = draft;
    setDraft(null);
    if (!d || !done) return;
    writeMockup(node, { ...config, mesh: done });
  };
  const outline = [...mesh.top, ...[...mesh.bottom].reverse()].map((p) => { const s = at(p); return `${s.left},${s.top}`; }).join(' ');
  return (
    <div className="ov-mockup" data-ui data-testid="mockup-handles">
      <svg className="ov-mockup-outline" aria-hidden="true"><polygon points={outline} /></svg>
      {CORNERS.map((c) => (
        <div
          key={c}
          className="ov-mockup-handle"
          style={at(cornerPoint(mesh, c))}
          role="slider"
          aria-label={t('Corner of the print')}
          aria-valuetext={c}
          tabIndex={-1}
          onPointerDown={begin(c)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          data-testid={`mockup-corner-${c}`}
        />
      ))}
    </div>
  );
}
