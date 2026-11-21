import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { canvasDeviceFrames, deviceFrameSvg, deviceGeometry, deviceProfile, roundedPath, shownScreen, type CanvasDeviceFrame, type DeviceGeometry } from '@bogen/core';
import { useFrameVersion } from '../doc/hooks.ts';
import { session } from '../doc/session.ts';
import { useEditor } from '../state/store.ts';
import { rectOf } from './measure.ts';
import { onOverlayTick } from './overlay-tick.ts';

/**
 * Device frames around artboards on the canvas (`meta.deviceFrames`): a view of the artboard that changes nothing in
 * it and does not export. The frame is drawn over the artboard with a hole for the screen, so the island sits over
 * the content as on the device, and the artboard's own corners are rounded to the screen's by a canvas-only clip.
 */
export function DeviceFramesLayer() {
  const pageId = useEditor((s) => s.pageId);
  return pageId ? <FramesOn pageId={pageId} /> : null;
}

interface Placed { id: string; geometry: DeviceGeometry; svg: string; turned: boolean; clip: string }

/** The frame around an artboard of this size, or null when it has none. */
export function placedFrame(id: string, frame: CanvasDeviceFrame | undefined, w: number, h: number): Placed | null {
  const p = frame ? deviceProfile(frame.device) : undefined;
  if (!p || w <= 0 || h <= 0) return null;
  // A phone or tablet artboard wider than tall is the device on its side; a browser window never turns.
  const turned = p.kind !== 'desktop' && w > h;
  const geometry = deviceGeometry(p, turned ? { width: h, height: w } : { width: w, height: h });
  const r = geometry.screen.radius;
  return { id, geometry, turned, svg: deviceFrameSvg(p, geometry, { finish: frame!.finish, turned }), clip: r > 0 ? roundedPath(0, 0, w, h, r, geometry.continuous) : '' };
}

/** How far above the artboard the frame reaches, in canvas units, so that its label sits above the device. */
export function frameTopOf(id: string, w: number, h: number): number {
  const placed = placedFrame(id, canvasDeviceFrames(session().doc)[id], w, h);
  return placed ? shownScreen(placed.geometry, placed.turned).y : 0;
}

function FramesOn({ pageId }: { pageId: string }) {
  const version = useFrameVersion();
  const [, setTick] = useState(0);
  useEffect(() => onOverlayTick(() => setTick((v) => v + 1)), []);
  const { snap, doc } = session();
  const frames = canvasDeviceFrames(doc);
  const ids = useMemo(() => Object.keys(frames).filter((id) => {
    const n = snap.nodes.get(id);
    return n?.artboard && !snap.isHidden(id) && snap.pageOf(id) === pageId;
  }).slice(0, 100), [version, pageId, snap, frames]);
  const placed = ids.flatMap((id) => {
    const r = rectOf(id);
    const p = r ? placedFrame(id, frames[id], r.w, r.h) : null;
    return r && p ? [{ ...p, r }] : [];
  });
  if (!placed.length) return null;
  const clips = placed.filter((p) => p.clip).map((p) => `.bogen-world [data-bogen-id="${CSS.escape(p.id)}"] { clip-path: path('${p.clip}'); }`).join('\n');
  return (
    <>
      {clips ? <style data-testid="device-frame-clips">{clips}</style> : null}
      {placed.map(({ id, geometry, svg, turned, r }) => {
        const screen = shownScreen(geometry, turned);
        const w = turned ? geometry.height : geometry.width;
        const h = turned ? geometry.width : geometry.height;
        // The drawing is in the screen's units: scaled so that its screen is the artboard.
        const k = r.w / screen.w;
        const style = { '--wx': r.x - screen.x * k, '--wy': r.y - screen.y * k, '--ww': w * k, '--wh': h * k } as CSSProperties;
        return <div key={id} className="ov-device-frame" data-testid="device-frame" data-frame={id} style={style} dangerouslySetInnerHTML={{ __html: svg }} />;
      })}
    </>
  );
}
