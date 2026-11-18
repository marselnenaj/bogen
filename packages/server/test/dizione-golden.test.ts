import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Phonemizer } from '../src/speech/dizione/engine.ts';

/**
 * The TypeScript port of dizione against the Python reference: fixtures/dizione-golden.json.gz holds, for 3,841
 * English sentences (Bogen's interface strings, templates with numbers, money, dates, units, codes, addresses and
 * homographs, dictionary words, made-up words, and random mixtures of emoji, accents, signs and chat spellings), the token ids and stress Python dizione gives
 * (scripts/dizione-golden.py). The phonemizer data is downloaded with the voice, so this runs only where it is:
 * BOGEN_TEST_DIZIONE=<folder with lexicon.tsv, align.json, g2p.json, g2p.npz, homographs.json>.
 */
const DATA = process.env.BOGEN_TEST_DIZIONE;
const fixture = JSON.parse(gunzipSync(readFileSync(join(import.meta.dirname, 'fixtures', 'dizione-golden.json.gz'))).toString('utf8')) as
  { rows: { text: string; ids?: number[]; stress?: number[]; error?: string }[] };

describe.skipIf(!DATA || !existsSync(join(DATA ?? '', 'lexicon.tsv')))('dizione port, golden sentences', () => {
  it('gives the same ids and stress as Python dizione', () => {
    const p = new Phonemizer(DATA!);
    const misses: string[] = [];
    let same = 0;
    for (const row of fixture.rows) {
      let got: { ids: number[]; stress: number[] } | null = null;
      try { got = p.phonemize(row.text); } catch { got = null; }
      const ok = row.ids ? Boolean(got) && JSON.stringify(got!.ids) === JSON.stringify(row.ids) && JSON.stringify(got!.stress) === JSON.stringify(row.stress) : got === null;
      if (ok) same++;
      else misses.push(row.text);
    }
    const agreement = same / fixture.rows.length;
    console.log(`dizione port: ${same}/${fixture.rows.length} sentences identical (${(agreement * 100).toFixed(2)} %)`);
    if (misses.length) console.log('first differences:\n' + misses.slice(0, 40).join('\n'));
    expect(agreement).toBeGreaterThanOrEqual(0.99);
  });
});
