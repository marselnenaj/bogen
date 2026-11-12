import { BRANCHES_ROOT, MAIN_BRANCH, Y } from '@bogen/core';

/**
 * The checked-out branch as this editor's copy of the document says it, read from the records in the root map
 * `designBranches` alone: never a snapshot, never a hash of the design. Cheap enough for every change.
 */
export interface LocalBranch { current: string; name: string | null; open: number; decided: number }

interface Rec { id?: unknown; name?: unknown; status?: unknown }

export function localBranch(y: Y.Doc): LocalBranch {
  const map = y.getMap<unknown>(BRANCHES_ROOT);
  let open = 0;
  let decided = 0;
  map.forEach((value, key) => {
    if (!key.startsWith('b:') || key === `b:${MAIN_BRANCH}`) return;
    const status = (value as Rec | null)?.status;
    if (status === 'open') open++;
    else if (status === 'merged' || status === 'discarded') decided++;
  });
  const id = map.get('current');
  const rec = typeof id === 'string' ? (map.get(`b:${id}`) as Rec | undefined) : undefined;
  if (typeof id === 'string' && id !== MAIN_BRANCH && rec?.status === 'open') return { current: id, name: typeof rec.name === 'string' ? rec.name : id, open, decided };
  return { current: MAIN_BRANCH, name: null, open, decided };
}

/** Whether a transaction moved the checkout: `current` or the checkout stamps of `designBranches` changed. */
export function movedCheckout(tr: Y.Transaction, y: Y.Doc): boolean {
  const map = y.getMap<unknown>(BRANCHES_ROOT);
  const keys = [...tr.changed].find(([type]) => (type as unknown) === map)?.[1];
  return Boolean(keys && (keys.has('current') || keys.has('checkouts')));
}

/**
 * Empties the local undo stack whenever the checked-out branch changes. The steps on it were recorded on the branch
 * that was live then; replaying them on another one would write that branch's edits into this one.
 * Returns the function that stops watching.
 */
export function clearUndoOnCheckout(y: Y.Doc, undo: Pick<Y.UndoManager, 'clear'>): () => void {
  const after = (tr: Y.Transaction) => {
    if (movedCheckout(tr, y)) undo.clear();
  };
  y.on('afterTransaction', after);
  return () => y.off('afterTransaction', after);
}

/** Calls `fn` when a branch record or the checkout changes, not for the snapshots stored beside them. */
export function onBranchRecords(y: Y.Doc, fn: () => void): () => void {
  const map = y.getMap<unknown>(BRANCHES_ROOT);
  const seen = (e: Y.YMapEvent<unknown>) => {
    for (const key of e.keysChanged) if (key === 'current' || key.startsWith('b:')) return fn();
    return undefined;
  };
  map.observe(seen);
  return () => map.unobserve(seen);
}
