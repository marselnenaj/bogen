import { intersects, unionRects, type Camera, type Rect } from '../canvas/geometry.ts';
import { elOf, rectOf } from '../canvas/measure.ts';
import { usesArtboardLoading } from '../canvas/artboard-loading.ts';
import { session } from '../doc/session.ts';
import { camera } from './camera.ts';
import { editor, useEditor } from './store.ts';

/**
 * What the view does on its own: a small page opens fitted, a page full of screens at its first readable
 * artboard, and both where they were left after that,
 * remembered per page on this device. Everything goes through one place, so that it holds however the
 * page changes: the page list, the palette, a comment, an agent.
 */
const PREFIX = 'bogen-view-';

function storageKey(fileId: string, pageId: string): string {
  return `${PREFIX}${fileId}-${pageId}`;
}

export function savedView(fileId: string, pageId: string): Camera | null {
  try {
    const raw = localStorage.getItem(storageKey(fileId, pageId));
    if (!raw) return null;
    const c = JSON.parse(raw) as Camera;
    return Number.isFinite(c.x) && Number.isFinite(c.y) && c.z > 0 ? c : null;
  } catch {
    return null;
  }
}

function saveView(fileId: string, pageId: string, c: Camera): void {
  try { localStorage.setItem(storageKey(fileId, pageId), JSON.stringify({ x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100, z: c.z })); } catch { /* private mode */ }
}

/** Bounds of what is on a page, without hidden layers, which measure as nothing at the origin. */
export function pageBounds(pageId: string): Rect | null {
  const { snap } = session();
  const rects = snap.children(pageId).flatMap((id) => {
    if (snap.nodes.get(id)?.hidden) return [];
    const r = rectOf(id);
    return r && r.w + r.h > 0 ? [r] : [];
  });
  return unionRects(rects);
}

/** Calls back when the layers of the page are in the DOM and the viewport has a size. */
function whenMounted(pageId: string, fn: () => void): () => void {
  let frame = 0;
  let tries = 0;
  const step = () => {
    camera.measureViewport();
    const { snap } = session();
    const kids = snap.children(pageId);
    const ready = camera.width > 0 && editor().pageId === pageId && kids.every((id) => elOf(id));
    if (ready || tries++ > 240) {
      frame = 0;
      fn();
    } else frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => cancelAnimationFrame(frame);
}

/** Frames the page, or goes back to where this person left it if that still shows something. */
function applyView(fileId: string, pageId: string): void {
  const saved = savedView(fileId, pageId);
  const bounds = pageBounds(pageId);
  if (saved) {
    const view: Rect = { x: -saved.x / saved.z, y: -saved.y / saved.z, w: camera.width / saved.z, h: camera.height / saved.z };
    if (!bounds || intersects(view, bounds)) {
      camera.set(saved, false);
      return;
    }
  }
  // Fitting hundreds of screens to 4% makes every one visible (and expensive) before anything is readable.
  // Start a large, new view at a useful screen; an explicitly saved overview still wins above.
  const { snap } = session();
  const roots = snap.children(pageId);
  if (usesArtboardLoading(roots.length, snap.nodes.size)) {
    const first = roots.flatMap((id) => {
      if (!snap.nodes.get(id)?.artboard || snap.nodes.get(id)?.hidden) return [];
      const rect = rectOf(id);
      return rect && rect.w >= 160 && rect.h >= 240 ? [rect] : [];
    })[0];
    if (first) { camera.fit(first, 1); return; }
  }
  if (bounds) camera.fit(bounds, 1);
  else camera.set({ x: camera.width / 2, y: camera.height / 2, z: 1 }, false);
}

/** Runs for one open file. Returns the teardown. */
export function installViews(fileId: string): () => void {
  let page = editor().pageId;
  let cancelMount: (() => void) | null = null;
  let saveTimer = 0;
  let applying = false;
  let emptyAtOpen = false;

  const flush = () => {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (page && !applying) saveView(fileId, page, camera.value);
  };
  const open = (pageId: string) => {
    cancelMount?.();
    applying = true;
    cancelMount = whenMounted(pageId, () => {
      cancelMount = null;
      applyView(fileId, pageId);
      emptyAtOpen = !session().snap.children(pageId).length;
      applying = false;
    });
  };

  const offCamera = camera.subscribe(() => {
    if (applying) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(flush, 250);
  });
  const offPage = useEditor.subscribe((s, prev) => {
    if (s.pageId === prev.pageId || !s.pageId) return;
    if (page && saveTimer) flush();
    page = s.pageId;
    open(s.pageId);
  });
  // Something an agent or a colleague puts on a page that was empty should not stay out of sight.
  const offStructure = session().snap.subscribeStructure(() => {
    if (!emptyAtOpen || !page || applying) return;
    if (!session().snap.children(page).length) return;
    emptyAtOpen = false;
    const current = page;
    requestAnimationFrame(() => {
      if (editor().pageId !== current || !elOfAny(current)) return;
      const bounds = pageBounds(current);
      if (bounds && !intersects(camera.visibleWorld(), bounds)) camera.fit(bounds, 1);
    });
  });
  if (page) open(page);

  return () => {
    cancelMount?.();
    if (saveTimer) flush();
    offCamera();
    offPage();
    offStructure();
  };
}

function elOfAny(pageId: string): boolean {
  return session().snap.children(pageId).some((id) => elOf(id));
}
