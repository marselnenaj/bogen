/**
 * align.py (run-time part): which letters spell which phoneme. Every phoneme gets a run of zero to four letters, in
 * order, so that the runs spell the word. The probability table comes with the phonemizer data (align.json).
 */

export const MAX_RUN = 4;
const UNSEEN = -14.0;

/** ARPABET symbol without its stress digit. */
export const base = (symbol: string): string => symbol.replace(/[012]+$/, '');

export class Aligner {
  constructor(private table: Record<string, Record<string, number>>) {}

  score(phone: string, run: string): number {
    const value = this.table[phone]?.[run];
    return value !== undefined ? value : UNSEEN - 2.0 * Math.abs(run.length - 1);
  }

  /** One run of letters per phoneme, or null when the word is too long for the pronunciation. */
  align(word: string, symbols: readonly string[]): string[] | null {
    const phones = symbols.map(base);
    const letters = word.length;
    const count = phones.length;
    if (!count || letters > MAX_RUN * count) return null;
    const low = -1e18;
    const best = Array.from({ length: count + 1 }, () => new Array<number>(letters + 1).fill(low));
    const step = Array.from({ length: count + 1 }, () => new Array<number>(letters + 1).fill(0));
    best[0]![0] = 0.0;
    for (let j = 1; j <= count; j++) {
      const phone = phones[j - 1]!, previous = best[j - 1]!, row = best[j]!, trace = step[j]!;
      for (let i = 0; i <= letters; i++) {
        for (let k = 0; k <= Math.min(MAX_RUN, i); k++) {
          if (previous[i - k]! > low) {
            const value = previous[i - k]! + this.score(phone, word.slice(i - k, i));
            if (value > row[i]!) { row[i] = value; trace[i] = k; }
          }
        }
      }
    }
    if (best[count]![letters]! <= low) return null;
    const runs: string[] = [];
    let i = letters;
    for (let j = count; j > 0; j--) {
      const k = step[j]![i]!;
      runs.push(word.slice(i - k, i));
      i -= k;
    }
    return runs.reverse();
  }
}
