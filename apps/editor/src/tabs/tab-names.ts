/**
 * Open files whose names look the same get a word after the name, so that two tabs never read alike: the folder when
 * their folders differ, "kept copy" for a theme copy kept after it was brought into its project, and, while two still
 * read alike, the start of the file id. Names alone are compared without case, spaces at the ends or repeated spaces.
 */

export interface NamedTab { id: string; name: string; folder?: string; kept?: boolean }

/** A word that tells a tab from its look-alikes. `kept` is the translated "kept copy". */
export interface TabHint { folder?: string; kept?: boolean; id?: string }

const same = (name: string) => name.trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/** The hint of every tab that needs one, by file id. Tabs with a name of their own get none. */
export function tabHints(tabs: readonly NamedTab[], untitled = ''): Map<string, TabHint> {
  const groups = new Map<string, NamedTab[]>();
  for (const t of tabs) {
    const key = same(t.name || untitled);
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  const out = new Map<string, TabHint>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const folders = new Set(group.map((t) => t.folder ?? ''));
    const kept = new Set(group.map((t) => Boolean(t.kept)));
    const hints = new Map<string, TabHint>(group.map((t) => [t.id, {
      ...(folders.size > 1 && t.folder ? { folder: t.folder } : {}),
      ...(kept.size > 1 && t.kept ? { kept: true } : {}),
    }]));
    // Still alike: the shortest start of the id that tells them apart, four characters at least.
    const sig = (t: NamedTab) => JSON.stringify(hints.get(t.id));
    const bySig = new Map<string, NamedTab[]>();
    for (const t of group) bySig.set(sig(t), [...(bySig.get(sig(t)) ?? []), t]);
    for (const alike of bySig.values()) {
      if (alike.length < 2) continue;
      let n = 4;
      while (n < 64 && new Set(alike.map((t) => t.id.slice(0, n))).size < alike.length) n++;
      for (const t of alike) hints.set(t.id, { ...hints.get(t.id), id: t.id.slice(0, n) });
    }
    for (const [id, h] of hints) if (Object.keys(h).length) out.set(id, h);
  }
  return out;
}

/** The hint as words: "Themes", "kept copy", "5ws7", or two of them with a middle dot. */
export function hintText(hint: TabHint | undefined, keptCopy: string): string {
  if (!hint) return '';
  return [hint.folder, hint.kept ? keptCopy : undefined, hint.id].filter(Boolean).join(' · ');
}
