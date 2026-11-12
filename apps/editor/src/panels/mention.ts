/** The word being typed as a mention at the caret. Pure. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(?:^|\s)@([\w.-]*)$/.exec(text.slice(0, caret));
  if (!m) return null;
  return { start: caret - m[1]!.length - 1, query: m[1]! };
}
