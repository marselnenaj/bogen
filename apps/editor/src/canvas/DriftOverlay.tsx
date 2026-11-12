import type { CSSProperties } from 'react';
import { useFrameVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { useDriftState } from '../panels/drift-state.ts';
import { useEditor } from '../state/store.ts';
import { rectOf } from './measure.ts';
import { useT } from '../i18n/react.ts';

/** The last drift check over its artboard: differing pixels in red, and dashed boxes where the live page has more. */
export function DriftOverlay() {
  const t = useT();
  const on = useDriftState((s) => s.overlay);
  const report = useDriftState((s) => s.report);
  const reportFile = useDriftState((s) => s.fileId);
  const focus = useDriftState((s) => s.focus);
  const fileId = useEditor((s) => s.fileId);
  const pageId = useEditor((s) => s.pageId);
  const tab = useEditor((s) => s.rightTab);
  useFrameVersion();
  if (!on || !report || reportFile !== fileId || tab !== 'drift') return null;
  if (session().doc.pageOf(report.node_id) !== pageId) return null;
  const board = rectOf(report.node_id);
  if (!board) return null;
  const place = (x: number, y: number, w: number, h: number) => ({ '--wx': board.x + x, '--wy': board.y + y, '--ww': w, '--wh': h }) as CSSProperties;
  const { overlay } = report.pixels;
  return (
    <>
      <img className="ov-drift" src={overlay.url} alt="" style={place(0, 0, overlay.width, overlay.height)} data-testid="drift-overlay" />
      {report.drifts.map((d, i) => (d.kind === 'extra' && d.live_element ? (
        <div key={i} className={`ov-drift-box${focus === i ? ' is-focus' : ''}`} style={place(d.live_element.box.x, d.live_element.box.y, d.live_element.box.width, d.live_element.box.height)} title={t('On the live page, not in the design: {selector}', { selector: d.live_element.selector })} />
      ) : null))}
    </>
  );
}
