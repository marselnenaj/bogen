import { unionRects } from '../canvas/geometry.ts';
import { rectOf } from '../canvas/measure.ts';
import { session } from '../doc/session.ts';
import { camera } from '../state/camera.ts';
import { editor } from '../state/store.ts';
import { prepareLayerMeasurements } from '../canvas/artboard-loading.ts';

/** Goes to layers: their page, selected, and in view. Layers that are gone are left out. False if none is left. */
export function jumpToLayers(ids: string[], pageId?: string): boolean {
  const { snap, doc } = session();
  const here = ids.filter((id) => snap.nodes.has(id));
  if (!here.length) return false;
  const state = editor();
  const page = pageId && snap.pages.some((p) => p.id === pageId) ? pageId : doc.pageOf(here[0]!);
  if (page && page !== state.pageId) state.set({ pageId: page, selection: [] });
  state.set({ selection: here });
  prepareLayerMeasurements(here);
  // Layers on a page that just opened are measured after it paints.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const box = unionRects(here.flatMap((id) => rectOf(id) ?? []));
    if (box) camera.fit(box, 1);
  }));
  return true;
}
