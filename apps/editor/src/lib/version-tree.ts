import type { DesignBranchRow } from './design-branches-api.ts';

/** Records form an ancestry tree, not an invented commit graph. Historical snapshots have no reliable branch tag. */
export function branchTree(rows: DesignBranchRow[]): { branch: DesignBranchRow; depth: number }[] {
  const byId = new Map(rows.map(b => [b.id, b])), out: { branch: DesignBranchRow; depth: number }[] = [], seen = new Set<string>();
  const visit = (b: DesignBranchRow, depth: number) => { if (seen.has(b.id)) return; seen.add(b.id); out.push({ branch: b, depth: Math.min(depth, 12) }); for (const child of rows) if (child.parent === b.id) visit(child, depth + 1); };
  for (const b of rows) if (!b.parent || !byId.has(b.parent)) visit(b, 0);
  for (const b of rows) visit(b, 0); // Imported cycles/orphans remain reachable.
  return out;
}
