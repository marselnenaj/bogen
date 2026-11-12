type Listener = () => void;

const listeners = new Set<Listener>();
let frame = 0;

/** Asks the overlay to re-measure on the next frame. Direct DOM edits call this. */
export function tickOverlay(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const l of listeners) l();
  });
}

export function onOverlayTick(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
