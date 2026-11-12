import { kebabCss, renderSpec } from '@bogen/core';
import { elOf } from '../canvas/measure.ts';
import { session } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { tickOverlay } from '../canvas/overlay-tick.ts';
import { overlapping, removable } from './simplify-rules.ts';
import { t } from '../i18n/store.ts';

/**
 * Removes styles that change nothing, and proves it: each removal is tried on the real element and
 * only stays if what the browser computes for the layer, and for everything inside it, stays the same.
 */
const INHERITED = ['color', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'font-feature-settings', 'font-variation-settings', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform', 'text-shadow', 'text-decoration-color', 'white-space', 'word-break', 'overflow-wrap', 'visibility', 'cursor', 'direction', 'writing-mode', 'list-style-type', 'list-style-position', 'caret-color', 'tab-size', 'quotes', 'pointer-events'];

const rectText = (el: Element, origin: DOMRect, z: number) => {
  const r = el.getBoundingClientRect();
  return `${Math.round(((r.left - origin.left) / z) * 50)},${Math.round(((r.top - origin.top) / z) * 50)},${Math.round((r.width / z) * 50)},${Math.round((r.height / z) * 50)}`;
};

/** What a layer looks like to the browser. Everything for itself, what can be passed on for what is inside. */
function signature(el: HTMLElement): string {
  const cs = getComputedStyle(el);
  let out = '';
  for (let i = 0; i < cs.length; i++) out += `${cs.getPropertyValue(cs[i]!)};`;
  const origin = el.getBoundingClientRect();
  const z = el.offsetWidth ? origin.width / el.offsetWidth || 1 : 1;
  const inner = el.querySelectorAll('*');
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    const ccs = getComputedStyle(c);
    out += `|${rectText(c, origin, z)}`;
    for (const p of INHERITED) out += `;${ccs.getPropertyValue(p)}`;
  }
  return out;
}

function firstDifference(before: string[], after: string[]): string {
  for (let i = 0; i < before.length; i++) {
    const a = before[i]!;
    const b = after[i]!;
    if (a === b) continue;
    let at = 0;
    while (at < a.length && a[at] === b[at]) at++;
    return `root ${i}: …${a.slice(Math.max(0, at - 60), at + 60)} became …${b.slice(Math.max(0, at - 60), at + 60)}`;
  }
  return 'nothing';
}

export interface SimplifyReport { layers: number; checked: number; removed: number; verified: boolean; changed: { id: string; keys: string[] }[] }

let running = false;

export async function simplifyStyles(): Promise<SimplifyReport | null> {
  if (running) return null;
  const s = session();
  const { snap } = s;
  const state = editor();
  const roots = state.selection.length ? state.selection : state.pageId ? [...snap.children(state.pageId)] : [];
  // Inside first, as what a child no longer states may be what its parent passes down.
  const order: string[] = [];
  const walk = (id: string) => {
    snap.children(id).forEach(walk);
    order.push(id);
  };
  roots.forEach(walk);
  if (!order.length) return null;

  running = true;
  const world = document.querySelector('.bogen-world');
  world?.classList.add('is-measuring');
  const applied = new Map<string, Record<string, string>>();
  const undoDom = new Map<string, string>();
  const report: SimplifyReport = { layers: 0, checked: 0, removed: 0, verified: false, changed: [] };
  const rootEls = roots.flatMap((id) => elOf(id) ?? []);
  try {
    const before = rootEls.map(signature);
    let lastYield = performance.now();
    for (const id of order) {
      const n = snap.nodes.get(id);
      const el = elOf(id);
      if (!n || !el || el.getAnimations().length) continue;
      const allKeys = Object.keys(n.style);
      // What the renderer puts there itself when nothing is said, such as pre-wrap on text, has to keep being said.
      const filledIn = renderSpec({ ...n, style: {} }).style;
      const candidates = Object.entries(n.style).filter(([k, v]) => !(k in filledIn) && removable(k, v) && !allKeys.some((o) => overlapping(k, o)));
      report.checked += Object.keys(n.style).length;
      if (!candidates.length) continue;
      const base = signature(el);
      const saved = el.style.cssText;
      const take = (keys: [string, string][]) => { for (const [k] of keys) el.style.removeProperty(kebabCss(k)); };
      const kept: [string, string][] = [];
      take(candidates);
      if (signature(el) !== base) {
        el.style.cssText = saved;
        for (const pair of candidates) {
          const before = el.style.cssText;
          take([pair]);
          if (signature(el) !== base) {
            el.style.cssText = before;
            kept.push(pair);
          }
        }
      }
      const gone = candidates.filter((c) => !kept.includes(c));
      if (gone.length) applied.set(id, Object.fromEntries(gone));
      undoDom.set(id, saved);
      if (performance.now() - lastYield > 40) {
        await new Promise((ok) => requestAnimationFrame(ok));
        lastYield = performance.now();
      }
    }
    const same = rootEls.map(signature).every((sig, i) => sig === before[i]);
    if (!same) {
      // Should not happen, as every step was checked. If it does, nothing is written.
      for (const [id, css] of undoDom) {
        const el = elOf(id);
        if (el) el.style.cssText = css;
      }
      editor().showToast(t('Nothing removed: the layers measured different when checked as a whole.'));
      return report;
    }
    if (!applied.size) {
      editor().showToast(t('Nothing to remove. Every style here changes the rendering.'));
      report.verified = true;
      return report;
    }
    s.tx(() => {
      for (const [id, map] of applied) {
        const n = snap.nodes.get(id);
        if (!n) continue;
        const patch: Record<string, null> = {};
        const keys: string[] = [];
        for (const [k, v] of Object.entries(map)) {
          // Someone may have changed it in the meantime; then it is theirs.
          if (n.style[k] === v) {
            patch[k] = null;
            keys.push(k);
          }
        }
        if (keys.length) {
          s.doc.updateStyle(id, patch);
          report.layers++;
          report.removed += keys.length;
          report.changed.push({ id, keys });
        }
      }
    });
    // And once more, now that the document itself no longer has them.
    await new Promise((ok) => requestAnimationFrame(ok));
    const after = rootEls.map((el) => (el.isConnected ? signature(el) : ''));
    report.verified = after.every((sig, i) => sig === before[i]);
    if (!report.verified) {
      // eslint-disable-next-line no-console
      console.warn('Simplify: measured different after writing', firstDifference(before, after));
      s.undo.undo();
      s.undo.redoStack.pop();
      editor().showToast(t('Undone: the layers measured different after the change.'));
      report.removed = 0;
      return report;
    }
    editor().showToast(t.n(report.layers, 'Removed {removed} of {checked} styles on {count} layer. Measured the same before and after.', 'Removed {removed} of {checked} styles on {count} layers. Measured the same before and after.', { removed: report.removed, checked: report.checked }));
    return report;
  } finally {
    world?.classList.remove('is-measuring');
    running = false;
    tickOverlay();
  }
}
