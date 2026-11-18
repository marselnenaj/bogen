/**
 * morphology.py: words the dictionary lacks but can be built from words it has: plurals, possessives, -ed, -ing, -ly
 * and other regular endings, a few prefixes, compounds of two dictionary words and British spellings.
 */

import { VOWEL_SET, type Phone, type Phones } from './symbols.ts';

const SHORT_STEM = /(?:^|[^aeiou])[aeiou](?:[bcdfgklmnprstvz]|th)$/;
const SIBILANT = new Set(['s', 'z', 'ʃ', 'ʒ', 'tʃ', 'dʒ']);
const VOICELESS = new Set(['p', 't', 'k', 'f', 'θ', 'ʔ']);
const SPLIT: Record<string, string> = { 'ɑːɹ': 'ɑː', 'ɔːɹ': 'ɔː', 'oːɹ': 'oː', 'ɪɹ': 'ɪ', 'ɛɹ': 'ɛ' };
const RHOTIC = new Set(['ɚ', 'ɜː', 'aɪɚ', 'ʊɹ']);
const CONSONANT_LETTERS = new Set('bcdfghjklmnpqrstvwxz');
const P = (...phones: string[]): Phone[] => phones.map((p) => [p, 0] as const);

const ENDINGS: [string, Phone[]][] = [
  ['fully', P('f', 'əl', 'i')], ['lessly', P('l', 'ə', 's', 'l', 'i')], ['ness', P('n', 'ə', 's')],
  ['less', P('l', 'ə', 's')], ['ments', P('m', 'ə', 'n', 't', 's')], ['ment', P('m', 'ə', 'n', 't')],
  ['ful', P('f', 'əl')], ['ship', [['ʃ', 0], ['ɪ', 2], ['p', 0]]], ['hood', [['h', 0], ['ʊ', 2], ['d', 0]]],
  ['like', [['l', 0], ['aɪ', 2], ['k', 0]]], ['dom', P('d', 'ə', 'm')], ['ish', P('ɪ', 'ʃ')],
  ['able', P('ə', 'b', 'əl')], ['ism', P('ɪ', 'z', 'ə', 'm')], ['ist', P('ɪ', 's', 't')],
  ['wards', P('w', 'ɚ', 'd', 'z')], ['ward', P('w', 'ɚ', 'd')], ['age', P('ɪ', 'dʒ')],
  ['ers', P('ɚ', 'z')], ['er', P('ɚ')], ['est', P('ɪ', 's', 't')], ['y', P('i')],
];
const both = (phones: Phone[]): [Phone[], Phone[]] => [phones, phones];
const PREFIXES: [string, [Phone[], Phone[]]][] = [
  ['under', both([['ʌ', 2], ['n', 0], ['d', 0], ['ɚ', 0]])], ['over', both([['oʊ', 2], ['v', 0], ['ɚ', 0]])],
  ['anti', both([['æ', 2], ['n', 0], ['t', 0], ['i', 0]])], ['semi', both([['s', 0], ['ɛ', 2], ['m', 0], ['i', 0]])],
  ['non', both([['n', 0], ['ɑː', 2], ['n', 0]])], ['out', both([['aʊ', 2], ['t', 0]])],
  ['dis', [P('d', 'ɪ', 's'), [['d', 0], ['ɪ', 2], ['s', 0]]]], ['mis', [P('m', 'ɪ', 's'), [['m', 0], ['ɪ', 2], ['s', 0]]]],
  ['un', [P('ʌ', 'n'), [['ʌ', 2], ['n', 0]]]], ['in', [P('ɪ', 'n'), [['ɪ', 2], ['n', 0]]]],
  ['re', [P('ɹ', 'ᵻ'), [['ɹ', 0], ['iː', 2]]]], ['pre', both([['p', 0], ['ɹ', 0], ['iː', 2]])],
];
const BRITISH: [string, string][] = [['isation', 'ization'], ['ising', 'izing'], ['ised', 'ized'], ['ises', 'izes'], ['ise', 'ize'], ['yse', 'yze'],
  ['our', 'or'], ['ourable', 'orable'], ['ours', 'ors'], ['oured', 'ored'], ['ouring', 'oring'],
  ['tre', 'ter'], ['tres', 'ters'], ['bre', 'ber'], ['ence', 'ense'], ['ogue', 'og'], ['mme', 'm'],
  ['lled', 'led'], ['lling', 'ling'], ['ller', 'ler'], ['oul', 'ol'], ['ae', 'e'], ['enqui', 'inqui']];

/** Stem + ending, adjusted at the seam. */
export function join(stemIn: Phones, ending: Phones): Phone[] {
  const stem: Phone[] = [...stemIn];
  if (!stem.length || !ending.length) return [...stem, ...ending];
  const [last, stress] = stem[stem.length - 1]!;
  const [first, firstStress] = ending[0]!;
  if (VOWEL_SET.has(first)) {
    if (last in SPLIT) stem.splice(stem.length - 1, 1, [SPLIT[last]!, stress], ['ɹ', 0]);
    else if (RHOTIC.has(last)) stem.push(['ɹ', 0]);
    else if (last === 't' && stem.length > 1 && (VOWEL_SET.has(stem[stem.length - 2]![0]) || stem[stem.length - 2]![0] === 'ɹ') && !firstStress
      && !(first === 'ə' && ending.length > 1 && ending[1]![0] === 'n')) stem[stem.length - 1] = ['ɾ', 0];
    else if (last === 'i') stem[stem.length - 1] = first !== 'ɪ' ? ['ɪ', stress] : ['i', stress];
  } else if (last === 'i' && ['n', 'l', 'f', 'm'].includes(first)) {
    stem[stem.length - 1] = ['ɪ', stress];
  } else if (last === 'n' && (first === 'k' || first === 'ɡ')) {
    stem[stem.length - 1] = ['ŋ', 0];
  }
  return [...stem, ...ending];
}

export function plural(stem: Phones): Phone[] {
  const last = stem[stem.length - 1]![0];
  return join(stem, SIBILANT.has(last) ? P('ᵻ', 'z') : VOICELESS.has(last) ? P('s') : P('z'));
}

export function past(stem: Phones): Phone[] {
  const last = stem[stem.length - 1]![0];
  if (['t', 'd', 'ɾ'].includes(last)) return join(stem, P('ᵻ', 'd'));
  return join(stem, VOICELESS.has(last) || ['s', 'ʃ', 'tʃ'].includes(last) ? P('t') : P('d'));
}

export function adverb(stem: Phones): Phone[] {
  const last = stem[stem.length - 1]![0];
  return join(stem, last === 'əl' || last === 'l' ? P('i') : P('l', 'i'));
}

function stems(body: string): string[] {
  const out = [body];
  if (body.length > 2 && body[body.length - 1] === body[body.length - 2] && CONSONANT_LETTERS.has(body[body.length - 1]!)) out.push(body.slice(0, -1));
  if (body && (CONSONANT_LETTERS.has(body[body.length - 1]!) || body.endsWith('u'))) {
    const single = SHORT_STEM.test(body);
    out.splice(single ? 0 : out.length, 0, body + 'e');
  }
  if (body.endsWith('i') && body.length > 2) out.push(body.slice(0, -1) + 'y');
  return out;
}

const secondary = (phones: Phones): Phone[] => phones.map(([p, s]) => [p, s === 1 ? 2 : s] as const);

/** Two words said as one: the second keeps only a lesser stress. */
export const compound = (first: Phones, second: Phones): Phone[] => join(first, secondary(second));

type Lookup = (spelling: string) => Phone[] | null;

/** Pronunciation of `word` from a shorter dictionary word, or null. */
export function derive(word: string, lookup: Lookup, partIn?: Lookup | null, depth = 0): Phone[] | null {
  const part = partIn ?? lookup;
  const stem = (spelling: string): Phone[] | null => {
    if (spelling.length < 2) return null;
    const known = lookup(spelling);
    if (known && known.length) return known;
    return depth < 2 ? derive(spelling, lookup, part, depth + 1) : null;
  };
  const first = (candidates: string[], build: (found: Phone[]) => Phone[] | null): Phone[] | null => {
    for (const spelling of candidates) {
      const found = stem(spelling);
      if (found && found.length) return build(found);
    }
    return null;
  };
  const ok = (p: Phone[] | null): p is Phone[] => Boolean(p && p.length);
  if (word.endsWith("'s")) return first([word.slice(0, -2)], plural);
  if (word.endsWith("s'")) return first([word.slice(0, -1)], (found) => found);
  let found: Phone[] | null;
  if (word.endsWith('ies') && word.length > 4 && ok(found = first([word.slice(0, -3) + 'y'], plural))) return found;
  if (word.endsWith('ves') && word.length > 4
    && ok(found = first([word.slice(0, -3) + 'f', word.slice(0, -3) + 'fe'], (f) => (f[f.length - 1]![0] === 'f' ? join([...f.slice(0, -1), ['v', 0]], P('z')) : null)))) return found;
  if (word.endsWith('es') && word.length > 3 && ok(found = first('sxzh'.includes(word[word.length - 3]!) ? [word.slice(0, -2)] : [], plural))) return found;
  if (word.endsWith('s') && !['ss', 'us', 'is'].some((e) => word.endsWith(e)) && word.length > 3 && ok(found = first([word.slice(0, -1)], plural))) return found;
  if (word.endsWith('ied') && word.length > 4 && ok(found = first([word.slice(0, -3) + 'y'], past))) return found;
  if (word.endsWith('ed') && word.length > 3 && ok(found = first(stems(word.slice(0, -2)), past))) return found;
  if (word.endsWith('ing') && word.length > 4 && ok(found = first(stems(word.slice(0, -3)), (f) => join(f, P('ɪ', 'ŋ'))))) return found;
  if (word.endsWith('ily') && word.length > 4 && ok(found = first([word.slice(0, -3) + 'y'], adverb))) return found;
  if (word.endsWith('ly') && word.length > 3) {
    const candidates = word.endsWith('bly') || word.endsWith('ply') ? [word.slice(0, -2), word.slice(0, -2) + 'le', word.slice(0, -1) + 'e'] : [word.slice(0, -2)];
    if (ok(found = first(candidates, adverb))) return found;
  }
  for (const [spelling, phones] of ENDINGS) {
    if (word.endsWith(spelling) && word.length - spelling.length > 2) {
      const body = word.slice(0, -spelling.length);
      if (spelling === 'y' && !CONSONANT_LETTERS.has(body[body.length - 1]!)) continue;
      const vowelFirst = VOWEL_SET.has(phones[0]![0]);
      const candidates = vowelFirst ? stems(body) : body.endsWith('i') ? [body.slice(0, -1) + 'y', body] : [body];
      if (ok(found = first(candidates, (f) => join(f, phones)))) return found;
    }
  }
  for (const [spelling, [plain, stressed]] of PREFIXES) {
    if (word.startsWith(spelling) && word.length - spelling.length > 2) {
      const rest = stem(word.slice(spelling.length));
      if (rest && rest.length) {
        const vowels = rest.filter(([p]) => VOWEL_SET.has(p)).map(([, s]) => s);
        return join(vowels.length && vowels[0] === 1 ? plain : stressed, rest);
      }
    }
  }
  for (const [old, replacement] of BRITISH) {
    if (word.includes(old)) {
      const rest = stem(word.replace(old, replacement));
      if (rest && rest.length) return rest;
    }
  }
  if (depth === 0) {
    let best: [number, Phone[], Phone[]] | null = null;
    for (let cut = 4; cut < word.length - 3; cut++) {
      const left = part(word.slice(0, cut)), right = part(word.slice(cut));
      if (left && left.length && right && right.length) {
        const score = Math.min(cut, word.length - cut);
        if (best === null || score > best[0]) best = [score, left, right];
      }
    }
    if (best) return compound(best[1], best[2]);
  }
  return null;
}
