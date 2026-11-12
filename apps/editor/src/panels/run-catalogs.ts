import { isRunnerId } from '@bogen/core';

/**
 * The runners of a picker whose catalog is still to be asked for: each known runner once, and none that is
 * already there or on its way. Only these are asked, never every runner: a catalog of a newer runner starts that
 * CLI on the computer.
 */
export function catalogsToLoad(catalogs: Record<string, unknown> | undefined, runners: readonly string[], pending: ReadonlySet<string>): string[] {
  if (!catalogs) return [];
  return [...new Set(runners)].filter((r) => isRunnerId(r) && !catalogs[r] && !pending.has(r));
}
