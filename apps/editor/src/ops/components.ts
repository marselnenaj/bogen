import { addVariant, createComponent, createInstance, detachInstance, isLibraryParent, isVirtualId, ownerOf, type NewNode } from '@bogen/core';
import { flushSync } from 'react-dom';
import { rectOf, flowOf, idsAtPoint, toParentLocal } from '../canvas/measure.ts';
import { session } from '../doc/session.ts';
import { fmtPx } from '../lib/css-values.ts';
import { camera } from '../state/camera.ts';
import { editor } from '../state/store.ts';
import { ensurePositioned, insertAt, isContainer, pageId, topLevelOf, visibleCentre, wrapIn } from './ops.ts';
import { t } from '../i18n/store.ts';

/** Ctrl+Alt+K: the selected layer becomes a main in place. Several are wrapped in a frame first. */
export function makeComponent(): void {
  const s = session();
  const { snap, doc } = s;
  const ids = topLevelOf(editor().selection).filter((id) => !isVirtualId(id));
  if (!ids.length) {
    editor().showToast(t('Layers inside an instance cannot become a component. Edit its main instead.'));
    return;
  }
  const single = ids.length === 1 ? snap.nodes.stored(ids[0]!) : undefined;
  if (single?.component) {
    editor().showToast(t('{name} is a component already.', { name: single.name }));
    return;
  }
  s.beginGesture();
  try {
    const target = single && single.instanceOf === undefined ? single.id : wrapIn(ids, { name: 'Component' });
    if (!target) return;
    s.tx(() => createComponent(doc, target));
    editor().set({ selection: [target] });
    editor().showToast(t('Component made. Its instances are in Assets.'));
  } finally {
    s.endGesture();
  }
}

/** The frame under a point that can take a new layer, or the page. */
function dropParentAt(clientX: number, clientY: number): string {
  const { snap } = session();
  for (const id of idsAtPoint(clientX, clientY)) {
    const n = snap.nodes.get(id);
    if (n && !snap.isLocked(id) && isContainer(n) && !(n.virtual && n.slotName === undefined)) return id;
  }
  return pageId();
}

/** An instance where a drag from the assets panel ended. */
export function dropInstance(mainId: string, clientX: number, clientY: number): string | null {
  const s = session();
  const { snap, doc } = s;
  const main = snap.nodes.stored(mainId);
  if (!main) return null;
  camera.measureViewport();
  const world = camera.worldAt(clientX, clientY);
  let parent = dropParentAt(clientX, clientY);
  // Never inside its own main, where it would go on for ever.
  if (parent === mainId || snap.ancestors(parent).includes(mainId)) parent = pageId();
  const flow = snap.nodes.has(parent) && flowOf(parent).kind === 'flow';
  const local = toParentLocal(parent, world);
  const style: Record<string, string> = flow ? {} : { position: 'absolute', left: fmtPx(local.x), top: fmtPx(local.y) };
  let id = '';
  try {
    flushSync(() => {
      s.tx(() => {
        if (!flow && snap.nodes.has(parent)) ensurePositioned(parent);
        id = createInstance(doc, mainId, parent, { style });
      });
    });
  } catch (err) {
    editor().showToast((err as Error).message);
    return null;
  }
  editor().set({ selection: [id], tool: 'move' });
  return id;
}

/** Selects the main of the selected instance, on its page, and brings it into view. */
export function goToMain(id?: string): void {
  const s = session();
  const target = id ?? editor().selection[0];
  if (!target) return;
  const node = s.snap.nodes.get(target);
  const owner = node?.instanceOf ?? (node?.virtual ? s.snap.nodes.get(node.virtual.owner)?.instanceOf : undefined);
  if (!owner || !s.snap.nodes.stored(owner)) {
    editor().showToast(t('This layer has no main.'));
    return;
  }
  const source = node?.virtual && node.instanceOf === undefined ? node.virtual.source : owner;
  const page = s.snap.pageOf(owner);
  if (!page && isLibraryParent(s.snap.nodes.stored(owner)?.parent)) {
    editor().showToast(t('This component comes from a shared library. Change it in the library\'s file and publish it there.'));
    return;
  }
  if (page && page !== editor().pageId) editor().set({ pageId: page, selection: [], hoverId: null });
  editor().set({ selection: [source] });
  requestAnimationFrame(() => {
    const r = rectOf(source);
    if (r) camera.fit(r, 1);
  });
}

export function detachSelection(): void {
  const s = session();
  const ids = [...new Set(editor().selection.map(ownerOf))].filter((id) => s.snap.nodes.stored(id)?.instanceOf !== undefined);
  if (!ids.length) {
    editor().showToast(t('Select an instance to detach.'));
    return;
  }
  s.tx(() => ids.forEach((id) => detachInstance(s.doc, id)));
  editor().set({ selection: ids });
}

/** A copy of a main as a new member of its variant set, next to it, selected to be restyled. */
export function addVariantOf(mainId: string, axis: string, value: string, baseValue?: string): void {
  const s = session();
  const main = s.snap.nodes.stored(mainId);
  if (!main) return;
  const r = rectOf(mainId);
  let id = '';
  flushSync(() => {
    s.tx(() => {
      id = addVariant(s.doc, mainId, { [axis]: value }, {
        ...(baseValue ? { base: { [axis]: baseValue } } : {}),
        ...(main.style.left && r ? { left: fmtPx(Number.parseFloat(main.style.left) + r.w + 40) } : {}),
      });
    });
  });
  editor().set({ selection: [id] });
}

/** An icon as a vector layer: in the selected frame if there is one, else in the middle of the view. */
export function insertIcon(spec: NewNode): string {
  const s = session();
  const { snap } = s;
  const first = editor().selection[0];
  const selected = first ? snap.nodes.get(first) : undefined;
  let parent = pageId();
  if (selected && isContainer(selected)) parent = first!;
  else if (selected && (snap.nodes.has(selected.parent))) {
    const up = snap.nodes.get(selected.parent)!;
    if (isContainer(up)) parent = up.id;
  }
  const c = visibleCentre();
  const id = insertAt(parent, spec, { x: c.x - 12, y: c.y - 12 });
  editor().set({ selection: [id], tool: 'move' });
  return id;
}
