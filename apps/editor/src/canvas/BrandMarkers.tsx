import { useMemo } from 'react';
import { useFrameVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { useBrandState } from '../panels/brand-state.ts';
import { editor, useEditor } from '../state/store.ts';
import { rectOf } from './measure.ts';
import type { CSSProperties } from 'react';

/** Quiet dots on layers that break the brand, one per layer, in the corner. Clicking one selects it and opens the list. */
export function BrandMarkers() {
  const on = useBrandState((s) => s.markers);
  const report = useBrandState((s) => s.report);
  const reportFileId = useBrandState((s) => s.reportFileId);
  const fileId = useEditor((s) => s.fileId);
  const pageId = useEditor((s) => s.pageId);
  useFrameVersion();
  const { doc } = session();
  const marks = useMemo(() => {
    if (!report || reportFileId !== fileId) return [];
    const byLayer = new Map<string, { hard: boolean; text: string[] }>();
    for (const v of report.violations) {
      if (!v.node_id) continue;
      const hit = byLayer.get(v.node_id) ?? { hard: false, text: [] };
      hit.hard ||= v.severity === 'hard';
      hit.text.push(v.message);
      byLayer.set(v.node_id, hit);
    }
    return [...byLayer];
  }, [report, reportFileId, fileId]);
  if (!on) return null;
  return (
    <>
      {marks.map(([id, mark]) => {
        if (doc.pageOf(id) !== pageId) return null;
        const r = rectOf(id);
        if (!r) return null;
        return (
          <div
            key={id}
            className={`ov-brand-mark${mark.hard ? ' is-hard' : ''}`}
            style={{ '--wx': r.x + r.w, '--wy': r.y } as CSSProperties}
            title={mark.text.slice(0, 4).join('\n')}
            data-testid="brand-marker"
            data-ui
            onPointerDown={(e) => {
              e.stopPropagation();
              editor().set({ selection: [id], leftTab: 'brand' });
            }}
          />
        );
      })}
    </>
  );
}
