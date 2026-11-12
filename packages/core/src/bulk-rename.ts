/**
 * Renaming several layers at once. A pattern names each layer: `$&` is its current name, `$n` counts up
 * from `start` and `$N` counts down to it, both padded to the width of the largest number when written as
 * `$nn` or `$NN`. Find and replace works inside the current names first, and `$&` then means the result.
 */

export interface RenamePlan {
  /** Such as "Card $n" or "$& copy". Leave out to keep the names, after find and replace. */
  pattern?: string;
  /** Text to replace inside each name. */
  find?: string;
  replace?: string;
  caseSensitive?: boolean;
  /** The first number, 1 by default. */
  start?: number;
}

export const MAX_LAYER_NAME = 200;

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** New names for layers with these names, in this order. A name that would be empty keeps the old one. */
export function bulkRename(names: readonly string[], plan: RenamePlan): string[] {
  const start = Number.isFinite(plan.start) ? Math.trunc(plan.start!) : 1;
  const last = start + names.length - 1;
  const width = String(Math.max(Math.abs(start), Math.abs(last))).length;
  const findRe = plan.find ? new RegExp(escape(plan.find), plan.caseSensitive ? 'g' : 'gi') : null;
  return names.map((name, i) => {
    let base = findRe ? name.replace(findRe, () => plan.replace ?? '') : name;
    if (plan.pattern !== undefined && plan.pattern !== '') {
      const up = start + i;
      const down = last - i;
      const pad = (n: number, wide: boolean) => (wide ? String(n).padStart(width, '0') : String(n));
      base = plan.pattern.replace(/\$(&|nn|NN|n|N)/g, (_, token: string) => {
        if (token === '&') return base;
        if (token === 'nn' || token === 'n') return pad(up, token === 'nn');
        return pad(down, token === 'NN');
      });
    }
    const out = base.trim().slice(0, MAX_LAYER_NAME);
    return out || name;
  });
}
