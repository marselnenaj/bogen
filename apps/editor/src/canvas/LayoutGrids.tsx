import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { gridLines, layoutGridTracks, type BogenNode } from '@bogen/core';
import { useFrameVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { useSettings } from '../state/settings.ts';
import { useEditor } from '../state/store.ts';
import { rectOf } from './measure.ts';
import { onOverlayTick } from './overlay-tick.ts';

/**
 * The layout grids of the frames on this page, under the selection. Positioned by the camera's CSS variables
 * like the other world-anchored marks, so that panning and zooming render nothing.
 */
export function LayoutGridsLayer() {
  const shown = useSettings((s) => s.layoutGrids);
  const pageId = useEditor((s) => s.pageId);
  return shown && pageId ? <GridsOn pageId={pageId} /> : null;
}

function GridsOn({ pageId }: { pageId: string }) {
  const version = useFrameVersion();
  const [, setTick] = useState(0);
  // Frames move and resize while a drag is open, between document versions.
  useEffect(() => onOverlayTick(() => setTick((v) => v + 1)), []);
  const { snap } = session();
  const frames = useMemo(() => {
    const out: BogenNode[] = [];
    for (const [id, n] of snap.nodes) if (n.layoutGrids && !snap.isHidden(id) && snap.pageOf(id) === pageId) out.push(n);
    return out.slice(0, 200);
  }, [version, pageId, snap]);
  return <>{frames.map((n) => <FrameGrids key={n.id} n={n} />)}</>;
}

const zpx = (v: number) => `calc(var(--z) * ${v}px)`;

function FrameGrids({ n }: { n: BogenNode }) {
  const r = rectOf(n.id);
  if (!r || !n.layoutGrids) return null;
  return (
    <div className="ov-layout-grid" data-testid="layout-grid" data-frame={n.id} style={{ '--wx': r.x, '--wy': r.y, '--ww': r.w, '--wh': r.h } as CSSProperties}>
      {n.layoutGrids.map((g, i) => {
        if (g.hidden) return null;
        const color = g.color ? ({ '--lg': g.color } as CSSProperties) : undefined;
        if (g.kind === 'grid') {
          const lines = gridLines(g, r);
          if (!lines.x.length && !lines.y.length) return null;
          return <div key={i} className="ov-layout-cells" style={{ ...color, backgroundSize: `${zpx(g.size ?? 8)} ${zpx(g.size ?? 8)}` }} data-testid="layout-grid-cells" />;
        }
        return layoutGridTracks(g, r).map((t, j) => (
          <div
            key={`${i}-${j}`}
            className={`ov-layout-track is-${g.kind}`}
            data-testid="layout-grid-track"
            style={{ ...color, ...(t.axis === 'x' ? { left: zpx(t.start), width: zpx(t.size), top: 0, bottom: 0 } : { top: zpx(t.start), height: zpx(t.size), left: 0, right: 0 }) }}
          />
        ));
      })}
    </div>
  );
}
