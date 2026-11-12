import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { clampCrop, type Crop } from '@bogen/core';
import { session } from '../doc/session.ts';
import { resolveAsset } from '../lib/api.ts';
import { cropOf, useNaturalSize, writeCrop } from '../ops/image-edit.ts';
import { camera } from '../state/camera.ts';
import { editor, useEditor } from '../state/store.ts';
import { ui, useUi } from '../state/ui.ts';
import { measure } from './measure.ts';
import { onOverlayTick, tickOverlay } from './overlay-tick.ts';
import { useT } from '../i18n/react.ts';

/**
 * Crop mode: the whole image dimmed around the layer, the crop box bright over it with eight handles. Drag inside
 * to move the image, drag a handle to change what is cropped. Enter or Esc ends it, and so does selecting
 * something else. One undo step per drag.
 */
export function CropHandles() {
  const on = useUi((s) => s.crop !== null);
  return on ? <CropBox /> : null;
}

type Handle = 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
interface Rect { x: number; y: number; w: number; h: number }
interface Drag { kind: Handle | 'move'; x: number; y: number; crop: Crop; box: Rect; image: Rect }

const MIN_BOX = 8;

export function endCrop(): void {
  if (ui().crop) ui().set({ crop: null });
}

function CropBox() {
  const t = useT();
  const nodeId = useUi((s) => s.crop?.nodeId ?? '');
  const selected = useEditor((s) => s.selection);
  const [, setN] = useState(0);
  const [draft, setDraft] = useState<{ crop: Crop; box: Rect } | null>(null);
  const drag = useRef<Drag | null>(null);
  useEffect(() => {
    const bump = () => setN((v) => v + 1);
    const a = camera.subscribe(bump);
    const b = onOverlayTick(bump);
    const c = session().snap.subscribe(tickOverlay);
    return () => { a(); b(); c(); };
  }, []);
  useEffect(() => {
    if (!selected.includes(nodeId)) endCrop();
  }, [selected, nodeId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      // Before the canvas, which would otherwise take Esc as "select the parent".
      e.preventDefault();
      e.stopPropagation();
      endCrop();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);
  const node = session().snap.nodes.get(nodeId);
  const natural = useNaturalSize(node?.type === 'image' ? node.src : undefined);
  useEffect(() => {
    if (!node || node.type !== 'image' || !node.src) endCrop();
  }, [node]);
  const m = measure(nodeId);
  if (!node || !m || !node.src) return null;
  const z = camera.value.z;
  const stored = cropOf(node);
  const box: Rect = draft?.box ?? { x: m.box.x * z + camera.value.x, y: m.box.y * z + camera.value.y, w: m.box.w * z, h: m.box.h * z };
  const crop = draft?.crop ?? stored;
  // While a handle moves, the image stays where it was when the drag began; otherwise it follows from the crop.
  const fixed = drag.current && drag.current.kind !== 'move' ? drag.current.image : null;
  const image: Rect = fixed ?? { x: box.x - (crop.x * box.w) / crop.w, y: box.y - (crop.y * box.h) / crop.h, w: box.w / crop.w, h: box.h / crop.h };
  const url = `url("${resolveAsset(node.src).replace(/["\\\n]/g, '')}")`;
  const filter = node.style.filter;

  const begin = (kind: Handle | 'move') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, x: e.clientX, y: e.clientY, crop, box, image };
  };
  const move = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const I = d.image;
    if (d.kind === 'move') {
      // The image moves under a box that stays put.
      const next = clampCrop({ ...d.crop, x: d.crop.x - dx / I.w, y: d.crop.y - dy / I.h });
      setDraft({ crop: next, box: d.box });
      return;
    }
    let left = d.box.x, top = d.box.y, right = d.box.x + d.box.w, bottom = d.box.y + d.box.h;
    if (d.kind.includes('w')) left = Math.min(right - MIN_BOX, Math.max(I.x, left + dx));
    if (d.kind.includes('e')) right = Math.max(left + MIN_BOX, Math.min(I.x + I.w, right + dx));
    if (d.kind.includes('n')) top = Math.min(bottom - MIN_BOX, Math.max(I.y, top + dy));
    if (d.kind.includes('s')) bottom = Math.max(top + MIN_BOX, Math.min(I.y + I.h, bottom + dy));
    if (e.shiftKey && d.kind.length === 2) {
      // Shift on a corner keeps the box's shape, from the opposite corner.
      const ratio = d.box.w / d.box.h;
      const w = right - left;
      const h = bottom - top;
      if (w / h > ratio) {
        const nw = h * ratio;
        if (d.kind.includes('w')) left = right - nw; else right = left + nw;
      } else {
        const nh = w / ratio;
        if (d.kind.includes('n')) top = bottom - nh; else bottom = top + nh;
      }
    }
    const next = { x: (left - I.x) / I.w, y: (top - I.y) / I.h, w: (right - left) / I.w, h: (bottom - top) / I.h };
    setDraft({ crop: clampCrop(next), box: { x: left, y: top, w: right - left, h: bottom - top } });
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    const done = draft;
    setDraft(null);
    if (!d || !done) return;
    if (d.kind === 'move') writeCrop(nodeId, done.crop, natural, { keepSize: true });
    else writeCrop(nodeId, done.crop, natural, { size: { width: done.box.w / z, height: done.box.h / z }, move: { dx: (done.box.x - d.box.x) / z, dy: (done.box.y - d.box.y) / z } });
  };

  const px = natural ? { w: Math.round(crop.w * natural.width), h: Math.round(crop.h * natural.height) } : null;
  return (
    <div className="ov-crop" data-ui data-testid="crop-handles">
      <div className="ov-crop-image" style={{ left: image.x, top: image.y, width: image.w, height: image.h, backgroundImage: url, filter }} />
      <div
        className="ov-crop-box"
        style={{ left: box.x, top: box.y, width: box.w, height: box.h, backgroundImage: url, backgroundSize: `${image.w}px ${image.h}px`, backgroundPosition: `${image.x - box.x}px ${image.y - box.y}px`, filter }}
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        title={t('Drag to move the image. Enter or Esc when done.')}
        data-testid="crop-box"
      />
      {HANDLES.map((h) => {
        const hx = h.includes('w') ? box.x : h.includes('e') ? box.x + box.w : box.x + box.w / 2;
        const hy = h.includes('n') ? box.y : h.includes('s') ? box.y + box.h : box.y + box.h / 2;
        return <div key={h} className={`ov-crop-handle is-${h}`} style={{ left: hx, top: hy }} onPointerDown={begin(h)} onPointerMove={move} onPointerUp={end} onPointerCancel={end} data-testid={`crop-handle-${h}`} />;
      })}
      <div className="ov-crop-label" style={{ left: box.x, top: box.y + box.h + 8 }}>
        {px ? `${px.w} x ${px.h}` : `${Math.round(crop.w * 100)}% x ${Math.round(crop.h * 100)}%`}
        <button type="button" className="ov-crop-done" onClick={() => { endCrop(); editor().set({ selection: [nodeId] }); }} data-testid="crop-done">{t('Done')}</button>
      </div>
    </div>
  );
}
