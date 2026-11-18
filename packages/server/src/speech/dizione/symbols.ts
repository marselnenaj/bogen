/**
 * Port of dizione (Apache-2.0, Muhammed Nazeem, https://github.com/n4ze3m/dizione), version 0.1.0, token convention 4:
 * English text to the phonemes the tiny-voca voices were trained on. Each file mirrors the Python module of the same
 * name; test/dizione-golden.test.ts checks the port against the Python output.
 *
 * symbols.py: 59 phones of American English, 12 punctuation marks and 5 special tokens. Lexical stress is a parallel
 * feature (0 none, 1 primary, 2 secondary). The order is append-only: the model's ids depend on it.
 */

export type Phone = readonly [phone: string, stress: number];
export type Phones = readonly Phone[];

export const PAD = '<pad>', BOS = '<bos>', EOS = '<eos>', SP = '<sp>', UNK = '<unk>';
export const SPECIALS = [PAD, BOS, EOS, SP, UNK];
export const PUNCTUATION = [',', '.', '?', '!', ';', ':', '"', "'", '(', ')', '—', '…'];
export const CONSONANTS = ['p', 'b', 't', 'd', 'k', 'ɡ', 'f', 'v', 'θ', 'ð', 's', 'z', 'ʃ', 'ʒ', 'h',
  'm', 'n', 'ŋ', 'l', 'ɹ', 'j', 'w', 'tʃ', 'dʒ', 'ɾ', 'ʔ'];
export const VOWELS = ['ə', 'ɐ', 'ɚ', 'ᵻ', 'ɪ', 'i', 'iː', 'ɛ', 'æ', 'ʌ', 'ɑː', 'ɔ', 'ɔː', 'ʊ', 'uː', 'ɜː',
  'eɪ', 'aɪ', 'ɔɪ', 'oʊ', 'aʊ', 'iə', 'oː',
  'ɑːɹ', 'ɔːɹ', 'oːɹ', 'ɪɹ', 'ɛɹ', 'ʊɹ', 'aɪɚ', 'aɪə', 'əl', 'n̩'];
export const PHONES = [...CONSONANTS, ...VOWELS];
export const SYMBOLS = [...SPECIALS, ...PUNCTUATION, ...PHONES];
export const SYMBOL_TO_ID = new Map(SYMBOLS.map((s, i) => [s, i]));
export const PHONE_SET = new Set(PHONES);
export const VOWEL_SET = new Set(VOWELS);

export interface Phonemized { symbols: string[]; ids: number[]; stress: number[]; unknown: string[] }

/** A run of words or one punctuation mark: `[true, mark]` or `[false, words]`, a word being its phones. */
export type Piece = readonly [true, string] | readonly [false, Phone[][]];

/** The token sequence: words separated by `<sp>`, repeated punctuation collapsed. */
export function tokenize(pieces: readonly Piece[]): Phonemized {
  const symbols = [BOS];
  const stress = [0];
  const unknown: string[] = [];
  for (const piece of pieces) {
    if (piece[0]) {
      if (symbols[symbols.length - 1] !== piece[1]) { symbols.push(piece[1]); stress.push(0); }
      continue;
    }
    for (const word of piece[1]) {
      const last = symbols[symbols.length - 1]!;
      if (PHONE_SET.has(last) || last === UNK) { symbols.push(SP); stress.push(0); }
      for (const [phone, level] of word) {
        if (PHONE_SET.has(phone)) { symbols.push(phone); stress.push(level); }
        else { unknown.push(phone); symbols.push(UNK); stress.push(0); }
      }
    }
  }
  symbols.push(EOS);
  stress.push(0);
  if (!symbols.some((s) => PHONE_SET.has(s) || s === UNK)) throw new Error('the text has nothing to pronounce');
  return { symbols, ids: symbols.map((s) => SYMBOL_TO_ID.get(s)!), stress, unknown };
}
