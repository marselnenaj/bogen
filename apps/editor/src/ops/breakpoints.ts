import { parseBlock, type BogenDoc, type BogenNode } from '@bogen/core';
import { session } from '../doc/session.ts';
import { editor } from '../state/store.ts';
import { ui } from '../state/ui.ts';
import { t } from '../i18n/store.ts';

/**
 * Editing at a breakpoint. With a width chosen in the inspector, every change the inspector makes goes into that
 * width's `@media (max-width: N px)` block on the layer instead of its base style, so a change for the phone never
 * reaches the desktop by accident. What the inspector shows is the layer as it is at that width: the base style with
 * every media block that applies there, narrower blocks winning, the way the cascade resolves them in a browser.
 */

export const DEFAULT_BREAKPOINTS = [1024, 768, 390];

/** The rule block key a breakpoint writes to. */
export function breakpointKey(width: number): string {
  return `@media (max-width: ${width}px)`;
}

/** The breakpoints a file names (tokens of kind breakpoint, in px), else the usual ones. */
export function fileBreakpoints(doc: BogenDoc): number[] {
  const own = doc.getTokens().filter((t) => t.kind === 'breakpoint').map((t) => Math.round(parseFloat(t.value))).filter((n) => n >= 200 && n <= 3000);
  return [...new Set(own.length ? own : DEFAULT_BREAKPOINTS)].sort((a, b) => b - a);
}

interface WidthBlock { key: string; max?: number; min?: number }

/** The media blocks of a layer that are plain width conditions, with no state or pseudo-element. */
function widthBlocks(n: BogenNode): WidthBlock[] {
  const out: WidthBlock[] = [];
  for (const key of Object.keys(n.rules ?? {})) {
    const b = parseBlock(key);
    if (!b?.at || b.at.kind !== 'media' || b.state || b.pseudo) continue;
    const max = /\(\s*max-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/.exec(b.at.query);
    const min = /\(\s*min-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/.exec(b.at.query);
    if (!max && !min) continue;
    if (b.at.query.replace(/\(\s*(max|min)-width\s*:\s*\d+(?:\.\d+)?px\s*\)|\s+and\s+/g, '').trim()) continue;
    out.push({ key, ...(max ? { max: Number(max[1]) } : {}), ...(min ? { min: Number(min[1]) } : {}) });
  }
  return out;
}

/** The layer's style at a viewport width: base, then min-width blocks from narrow to wide, then max-width blocks from wide to narrow. */
export function styleAt(n: BogenNode, width: number): Record<string, string> {
  const applies = widthBlocks(n).filter((b) => (b.max === undefined || width <= b.max) && (b.min === undefined || width >= b.min));
  applies.sort((a, b) => (a.min ?? 0) - (b.min ?? 0) || (b.max ?? Infinity) - (a.max ?? Infinity));
  const out = { ...n.style };
  for (const b of applies) Object.assign(out, n.rules![b.key]);
  return out;
}

/** The layer as the inspector shows it at a breakpoint. */
export function nodeAt(n: BogenNode, width: number | null): BogenNode {
  return width === null ? n : { ...n, style: styleAt(n, width) };
}

/** What this breakpoint itself overrides on a layer, as opposed to what it inherits. */
export function overridesAt(n: BogenNode, width: number): Record<string, string> {
  return { ...(n.rules?.[breakpointKey(width)] ?? {}) };
}

/**
 * What a property would be at this width without this width's own override, and where that comes from: the base
 * style or the nearest wider breakpoint. That is what resetting the override brings back.
 */
export function inheritedAt(n: BogenNode, width: number, prop: string): { value: string | undefined; from: string } {
  const own = breakpointKey(width);
  const rules = Object.fromEntries(Object.entries(n.rules ?? {}).filter(([k]) => k !== own));
  const value = styleAt({ ...n, rules }, width)[prop];
  const wider = widthBlocks({ ...n, rules }).filter((b) => b.max !== undefined && width <= b.max && rules[b.key]![prop] !== undefined).sort((a, b) => a.max! - b.max!)[0];
  return { value, from: wider ? `≤ ${wider.max}` : 'base' };
}

/** Writes a style patch for one layer, at the inspector's breakpoint when one is chosen. A null removes the override. */
export function updateScoped(doc: BogenDoc, id: string, patch: Record<string, string | null>): void {
  const width = ui().breakpoint;
  if (width === null) return doc.updateStyle(id, patch);
  doc.updateRules(id, breakpointKey(width), patch);
}

/** setStyle, scoped to the inspector's breakpoint. */
export function inspectorStyle(ids: string[], patch: Record<string, string | null>): void {
  const s = session();
  s.tx(() => {
    for (const id of ids) if (s.snap.nodes.has(id)) updateScoped(s.doc, id, patch);
  });
}

/** Opens the several-widths view for the selected layer's artboard, or the page's only artboard. */
export function showSizes(): void {
  const s = session();
  const state = editor();
  const sel = state.selection[0];
  const top = sel ? [sel, ...s.doc.ancestors(sel)].map((id) => s.doc.getNode(id)).find((n) => n?.artboard) : s.snap.children(state.pageId ?? '').map((id) => s.doc.getNode(id)).find((n) => n?.artboard);
  if (!top) return void state.showToast(t('Select a layer of the artboard to see at several widths.'));
  ui().set({ sizesOf: top!.id });
}
