import { matchingLayers, type FramePreset } from '@bogen/core';
import { computedBox } from '../canvas/measure.ts';
import { session } from '../doc/session.ts';
import { fmtPx } from '../lib/css-values.ts';
import { editor } from '../state/store.ts';
import { t } from '../i18n/store.ts';

/** Gives the selected frames a preset's size, fixed in both directions, keeping each one's orientation when asked. */
export function resizeToPreset(preset: FramePreset, ids: readonly string[] = editor().selection, landscape = false): void {
  const s = session();
  const frames = ids.filter((id) => s.snap.nodes.get(id)?.type === 'frame');
  if (!frames.length) return;
  const w = landscape ? preset.h : preset.w;
  const h = landscape ? preset.w : preset.h;
  s.tx(() => { for (const id of frames) s.doc.updateStyle(id, { width: fmtPx(w), height: fmtPx(h), flexGrow: null, flexBasis: null, aspectRatio: null }); });
}

/** Swaps width and height of the selected frames: portrait to landscape and back. A frame that hugs its content gets its measured height. */
export function swapOrientation(ids: readonly string[] = editor().selection): void {
  const s = session();
  const boxes = ids.flatMap((id) => {
    const n = s.snap.nodes.get(id);
    const box = computedBox(id);
    return n && box && !n.virtual ? [{ id, box }] : [];
  });
  if (!boxes.length) return;
  s.tx(() => { for (const { id, box } of boxes) s.doc.updateStyle(id, { width: fmtPx(box.height), height: fmtPx(box.width), flexGrow: null, flexBasis: null, aspectRatio: null }); });
}

/** Selects every layer on the page that matches the selection: the same look and shape, wherever it is and whatever it says. */
export function selectMatching(): void {
  const state = editor();
  if (!state.selection.length) return;
  const ids = matchingLayers(session().doc, state.selection).filter((id) => !session().snap.isLocked(id));
  if (!ids.length) return;
  state.set({ selection: ids });
  state.showToast(ids.length === 1 ? t('Nothing else matches') : t.n(ids.length, '{count} matching layer', '{count} matching layers'));
}
