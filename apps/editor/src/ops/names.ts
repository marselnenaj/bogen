import { autoLayerName, isGenericName, type BogenNode } from '@bogen/core';
import { session } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { t } from '../i18n/store.ts';

/** The first words inside a layer, breadth first, so that a heading wins over a footnote further down. */
export function firstTextIn(id: string, limit = 400): string | undefined {
  const { snap } = session();
  const queue = [...snap.children(id)];
  for (let i = 0; i < queue.length && i < limit; i++) {
    const n = snap.nodes.get(queue[i]!);
    if (!n) continue;
    if (n.text?.trim()) return n.text;
    queue.push(...snap.children(n.id));
  }
  return undefined;
}

export function contentName(n: BogenNode): string {
  const { snap } = session();
  return autoLayerName({ type: n.type, tag: n.tag, name: n.name, text: n.text, firstText: firstTextIn(n.id), attrs: n.attrs, style: n.style, childCount: snap.children(n.id).length });
}

/**
 * Names layers from what is in them. A selection is renamed outright, with everything inside it, except
 * names somebody gave on purpose; without a selection this goes over the whole page.
 */
export function renameFromContent(): void {
  const s = session();
  const { snap } = s;
  const state = editor();
  const roots = state.selection.length ? state.selection : state.pageId ? [...snap.children(state.pageId)] : [];
  const patches = new Map<string, string>();
  const walk = (id: string) => {
    const n = snap.nodes.get(id);
    if (!n) return;
    const isText = n.type === 'text';
    // A text layer whose name was its own text, at any point, follows the text; anything else named by a person stays.
    const replaceable = !n.artboard && (isGenericName(n.name) || (isText && (n.text ?? '').startsWith(n.name)));
    if (replaceable) {
      const name = contentName(n);
      if (name && name !== n.name) patches.set(id, name);
    }
    snap.children(id).forEach(walk);
  };
  roots.forEach(walk);
  if (!patches.size) {
    state.showToast(t('These layers already have names.'));
    return;
  }
  s.tx(() => { for (const [id, name] of patches) s.doc.updateFields(id, { name }); });
  state.showToast(t.n(patches.size, 'Renamed {count} layer from their content.', 'Renamed {count} layers from their content.'));
}
