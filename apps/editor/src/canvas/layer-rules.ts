import { layerRulesCss } from '@bogen/core';
import { maybeSession } from '../doc/session.ts';
import type { Snapshot } from '../doc/snapshot.ts';

/**
 * The style element with the pseudo-elements and conditional styles of every layer on screen, on the
 * canvas and in preview. A layer view says when it shows a layer with rules; the sheet is written again
 * at most once a frame from what the document says then, also when only an artboard changed, so that
 * an artboard's width reaches the media queries inside it.
 *
 * The rules come from `layerRulesCss`, as in screenshots: media width queries read the artboard, and
 * pointer and focus states only apply in preview mode (`.pv-world`), where a person is using the design
 * rather than editing it. Everything is scoped to `.bogen-world`, so no rule reaches the editor around it.
 */
const shown = new Map<string, number>();
let el: HTMLStyleElement | null = null;
let frame = 0;
let watching: { snap: Snapshot; off: () => void } | null = null;

export function showRules(id: string): () => void {
  shown.set(id, (shown.get(id) ?? 0) + 1);
  schedule();
  return () => {
    const n = (shown.get(id) ?? 1) - 1;
    if (n > 0) shown.set(id, n);
    else shown.delete(id);
    schedule();
  };
}

function schedule(): void {
  const active = maybeSession();
  // A parent's file cleanup runs before the layer effects are removed. Their
  // disposers must still be able to remove rules after the session is closed.
  if (!active) {
    clearSheet();
    return;
  }
  const { snap } = active;
  if (watching?.snap !== snap) {
    watching?.off();
    // Any change can move an artboard or give it another width, and the sheet has few entries.
    watching = { snap, off: snap.subscribe(() => { if (shown.size) schedule(); }) };
  }
  if (!frame) frame = requestAnimationFrame(write);
}

function write(): void {
  frame = 0;
  const active = maybeSession();
  // A queued frame can also land between closing one view and opening another.
  if (!active) {
    clearSheet();
    return;
  }
  const { snap } = active;
  const tokens = new Map(snap.tokens.map((t) => [t.name, t.value]));
  const parts: string[] = [];
  for (const id of [...shown.keys()].sort()) {
    const node = snap.nodes.get(id);
    if (!node?.rules || snap.isHidden(id)) continue;
    const topId = snap.ancestors(id).at(-1) ?? id;
    const top = snap.nodes.get(topId);
    const css = layerRulesCss(id, node.rules, {
      media: 'artboard',
      within: '.bogen-world:not([data-fluid]) ',
      states: '.pv-world:not([data-fluid])',
      token: (name) => tokens.get(name),
      ...(top ? { artboard: { id: topId, style: top.style, self: topId === id } } : {}),
    });
    if (css) parts.push(css);
    const fluidCss = layerRulesCss(id, node.rules, {
      media: 'viewport',
      within: '.pv-world[data-fluid] ',
      states: '.pv-world[data-fluid]',
      token: (name) => tokens.get(name),
    });
    if (fluidCss) parts.push(fluidCss);
  }
  const text = [...new Set(parts.join('\n').split('\n'))].join('\n');
  if (!el) {
    if (!text) return;
    el = document.createElement('style');
    el.dataset.testid = 'layer-rules';
    document.head.append(el);
  }
  if (el.textContent !== text) el.textContent = text;
}

function clearSheet(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  watching?.off();
  watching = null;
  if (el) el.textContent = '';
}
