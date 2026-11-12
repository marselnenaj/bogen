import { contains, unionRects } from '../canvas/geometry.ts';
import { rectOf } from '../canvas/measure.ts';
import { session } from '../doc/session.ts';
import { camera } from '../state/camera.ts';
import { editor } from '../state/store.ts';
import { prepareLayerMeasurements } from '../canvas/artboard-loading.ts';

/** Brings layers into view unless they already are. With `fit` the view also zooms to frame them. */
export function revealIfOffscreen(ids: string[], fit = true, mounted = false): void {
  if (!mounted && ids.some((id) => !rectOf(id))) {
    prepareLayerMeasurements(ids);
    const s = session();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (editor().fileId === s.fileId) revealIfOffscreen(ids, fit, true);
    }));
    return;
  }
  const u = unionRects(ids.flatMap((id) => rectOf(id) ?? []));
  if (!u) return;
  camera.measureViewport();
  if (contains(camera.visibleWorld(), u)) return;
  if (fit) {
    camera.fit(u, 1);
    return;
  }
  const c = camera.value;
  camera.set({ ...c, x: camera.width / 2 - (u.x + u.w / 2) * c.z, y: camera.height / 2 - (u.y + u.h / 2) * c.z }, false);
}

/** Goes to a layer wherever it is: its page, its place in the list, and on screen. */
export function goToLayer(id: string, options: { fit?: boolean } = {}): void {
  const { snap } = session();
  const page = snap.pageOf(id);
  const state = editor();
  const go = () => {
    state.set({ selection: [id] });
    revealIfOffscreen([id], options.fit ?? false);
  };
  if (page && page !== state.pageId) {
    state.set({ pageId: page, selection: [], hoverId: null });
    // After the view of the new page has settled, which takes a couple of frames.
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(go)));
  } else go();
}
