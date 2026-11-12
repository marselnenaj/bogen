import type { StoredFile } from '../doc/offline.ts';
import type { FileEntry } from '../lib/api.ts';
import { canonicalFiles } from '../lib/theme-library.ts';

const newestFirst = (a: FileEntry, b: FileEntry) => Number(new Date(b.updatedAt)) - Number(new Date(a.updatedAt));

/**
 * The files the phone lists, as Home does (canonicalFiles): a theme copy brought into another theme project is part
 * of that project, not a design of its own. Unlike Home, a kept copy stays listed while this phone holds something of
 * it, kept for offline or with edits waiting for the computer, so nothing that is only here goes out of reach. A copy
 * whose project is not in the list (deleted, or not synced yet) is an ordinary file, as on Home. Newest first.
 */
export function phoneFiles<T extends FileEntry>(list: readonly T[], stored: ReadonlyMap<string, Pick<StoredFile, 'kept' | 'queued'>>): T[] {
  const shown = canonicalFiles(list);
  const listed = new Set(shown.map((f) => f.id));
  const held = list.filter((f) => !listed.has(f.id) && (stored.get(f.id)?.kept || (stored.get(f.id)?.queued ?? 0) > 0));
  return [...shown, ...held].sort(newestFirst) as T[];
}

/**
 * The files an agent can be asked about from the phone: the canonical projects only, so a kept copy is never offered
 * as a new target. The file already chosen stays in the list, whatever it is, so the picker shows what is asked about.
 */
export function askTargets<T extends FileEntry>(list: readonly T[], current: string | null | undefined): T[] {
  const shown = canonicalFiles(list) as T[];
  const chosen = current && !shown.some((f) => f.id === current) ? list.find((f) => f.id === current) : undefined;
  return [...shown, ...(chosen ? [chosen] : [])].sort(newestFirst);
}
