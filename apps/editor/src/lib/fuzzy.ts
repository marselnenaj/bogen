/** Subsequence matching for the palette and pickers. Pure. */
export interface FuzzyMatch { score: number; indices: number[] }

const isBoundary = (text: string, i: number): boolean => {
  if (i === 0) return true;
  const prev = text[i - 1]!;
  const cur = text[i]!;
  return /[\s\-_/.:,()]/.test(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(cur));
};

/**
 * The best simple match of `query` in `text`, or null. Word starts and runs count for most, a short
 * text beats a long one, and the whole query appearing as written beats letters scattered about.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  const direct = t.indexOf(q);
  if (direct >= 0) {
    const indices = Array.from({ length: q.length }, (_, i) => direct + i);
    const score = 100 + q.length * 12 + (direct === 0 ? 60 : isBoundary(text, direct) ? 30 : 0) - text.length * 0.2;
    return { score, indices };
  }
  const indices: number[] = [];
  let score = 0;
  let at = 0;
  let run = 0;
  for (const c of q) {
    if (c === ' ') continue;
    let found = -1;
    // Prefer a word start ahead, as long as no letters would be skipped for nothing.
    for (let i = at; i < t.length; i++) {
      if (t[i] !== c) continue;
      if (found < 0) found = i;
      if (isBoundary(text, i)) {
        if (run === 0 || found === i) found = i;
        break;
      }
    }
    if (found < 0) return null;
    if (found === at && indices.length) { run++; score += 6 + run * 2; } else run = 0;
    if (isBoundary(text, found)) score += 14;
    score -= Math.min(6, (found - at) * 0.4);
    indices.push(found);
    at = found + 1;
  }
  return { score: score + 10 - text.length * 0.1, indices };
}
