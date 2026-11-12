/** "Zoom in (Ctrl+=)" into what it does and which keys do it. Pure. */
export function splitTitle(title: string): { label: string; keys: string | null } {
  const m = /^(.*\S)\s+\(([^()]{1,24})\)\s*$/.exec(title);
  if (!m) return { label: title, keys: null };
  const keys = m[2]!;
  const isKeys = /^(?:(?:Ctrl|Alt|Shift|⌘|⌥|⇧)\+?)*(?:[A-Z0-9←→↑↓=\-\\/,.[\]]|Esc|Enter|Del|Tab|Backspace|F\d+)$/.test(keys);
  return isKeys ? { label: m[1]!, keys } : { label: title, keys: null };
}
