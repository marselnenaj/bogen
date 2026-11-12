import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { session } from '../doc/session.ts';
import { fmt } from '../lib/css-values.ts';
import { setSpacing, spacingInfo } from '../ops/ops.ts';
import { camera } from '../state/camera.ts';
import { useEditor } from '../state/store.ts';
import { isDragging } from './pointer.ts';
import { onOverlayTick, tickOverlay } from './overlay-tick.ts';
import { useT } from '../i18n/react.ts';

/**
 * Handles in the gaps between selected layers that sit side by side with even spacing, as in a row of cards.
 * Dragging one changes every gap at once, the first layer staying put: one undo step per drag. The Spacing
 * fields in the inspector do the same from the keyboard.
 */
export function SpacingHandles() {
  const count = useEditor((s) => s.selection.length);
  return count >= 2 ? <Handles /> : null;
}

interface Drag { axis: 'x' | 'y'; x: number; y: number; gap: number }

function Handles() {
  const t = useT();
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const [, setN] = useState(0);
  const [live, setLive] = useState<{ axis: 'x' | 'y'; gap: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  useEffect(() => {
    const bump = () => setN((v) => v + 1);
    const a = camera.subscribe(bump);
    const b = onOverlayTick(bump);
    const c = session().snap.subscribe(tickOverlay);
    return () => { a(); b(); c(); };
  }, []);
  if (tool !== 'move' || (isDragging() && !drag.current)) return null;
  const { x: cx, y: cy, z } = camera.value;
  const out: React.ReactNode[] = [];
  for (const axis of ['x', 'y'] as const) {
    const info = spacingInfo(selection, axis);
    // Even spacing only, as a row or a column reads: a ragged set has nothing to drag as one.
    if (!info || info.gap === null) continue;
    const title = t('Spacing {gap}: drag to change every gap', { gap: fmt(info.gap) });
    const begin = (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      session().beginGesture();
      drag.current = { axis, x: e.clientX, y: e.clientY, gap: info.gap! };
      setLive({ axis, gap: info.gap! });
    };
    const move = (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.axis !== axis) return;
      const moved = (d.axis === 'x' ? e.clientX - d.x : e.clientY - d.y) / z;
      // Whole pixels, as everything else on the canvas snaps to them.
      const gap = Math.max(0, Math.round(d.gap + moved));
      setSpacing(d.axis, gap, selection);
      setLive({ axis: d.axis, gap });
    };
    const end = () => {
      if (!drag.current) return;
      drag.current = null;
      session().endGesture();
      setLive(null);
    };
    info.order.slice(1).forEach((index, k) => {
      const prev = info.rects[info.order[k]!]!;
      const next = info.rects[index]!;
      const gap = info.gaps[k]!;
      // In the gap, centred on the stretch where the two layers face each other.
      const along = axis === 'x' ? prev.x + prev.w + gap / 2 : prev.y + prev.h + gap / 2;
      const a0 = axis === 'x' ? Math.max(prev.y, next.y) : Math.max(prev.x, next.x);
      const a1 = axis === 'x' ? Math.min(prev.y + prev.h, next.y + next.h) : Math.min(prev.x + prev.w, next.x + next.w);
      const across = a1 > a0 ? (a0 + a1) / 2 : axis === 'x' ? (prev.y + prev.h / 2 + next.y + next.h / 2) / 2 : (prev.x + prev.w / 2 + next.x + next.w / 2) / 2;
      const sx = (axis === 'x' ? along : across) * z + cx;
      const sy = (axis === 'x' ? across : along) * z + cy;
      out.push(
        <div
          key={`${axis}${k}`}
          className={`ov-spacing ov-spacing-${axis}${live?.axis === axis ? ' is-active' : ''}`}
          style={{ left: sx, top: sy, ...(axis === 'x' ? { width: Math.max(6, gap * z) } : { height: Math.max(6, gap * z) }) }}
          data-ui
          data-spacing={axis}
          data-testid={`spacing-handle-${axis}`}
          title={title}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
        >
          <span />
          {live?.axis === axis && k === 0 ? <em className="ov-measure-label is-gap" data-testid="spacing-label">{fmt(live.gap)}</em> : null}
        </div>,
      );
    });
  }
  return <>{out}</>;
}
