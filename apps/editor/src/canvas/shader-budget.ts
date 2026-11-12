/**
 * Which shader layers get a live WebGL context. A browser allows about 16, and takes the oldest away
 * when there are more, so a page of shaders needs choosing. Pure, so that the rules can be tested.
 */
export const MAX_LIVE = 8;

export interface ShaderCandidate { id: string; visible: boolean; area: number; selected: boolean; hasStill: boolean }

export interface BudgetPlan {
  live: Set<string>;
  /** Over the budget and with no picture yet: one at a time it gets a moment to draw one. */
  capture: string | null;
}

/**
 * Selected layers first, as someone is working on them, then the largest on screen. One place stays free
 * for drawing stills of those that did not make it, so that nothing visible stays empty for long.
 */
export function planShaders(items: ShaderCandidate[], max = MAX_LIVE): BudgetPlan {
  const visible = items.filter((i) => i.visible);
  const ranked = [...visible].sort((a, b) => Number(b.selected) - Number(a.selected) || b.area - a.area || (a.id < b.id ? -1 : 1));
  const over = ranked.length > max;
  const seats = over ? max - 1 : max;
  const live = new Set(ranked.slice(0, seats).map((i) => i.id));
  const waiting = ranked.slice(seats).find((i) => !i.hasStill);
  if (waiting) live.add(waiting.id);
  return { live, capture: waiting?.id ?? null };
}
