/**
 * sentence.py: what a word's pronunciation owes to its neighbours within one clause: sentence stress of function
 * words, "the" and "to" before a vowel, linking r, and the flap at the end of "it" and "at" before a vowel.
 */

import { VOWEL_SET, type Phone, type Phones } from './symbols.ts';

const SPLIT: Record<string, string> = { 'ɑːɹ': 'ɑː', 'ɔːɹ': 'ɔː', 'oːɹ': 'oː', 'ɪɹ': 'ɪ', 'ɛɹ': 'ɛ', 'ʊɹ': 'ʊ' };
const RHOTIC = new Set(['ɚ', 'ɜː', 'aɪɚ']);
const NO_LINK_BEFORE = new Set(['and', 'or', 'if']);
const FLAP_BEFORE_VOWEL = new Set(['it', 'at']);

export class Unit {
  constructor(
    public word: string,
    public phones: Phones,
    public kind = 'c',
    public final: Phones | null = null,
    public attach = false,
    public source = '',
  ) {}
  get lastWord(): string { const parts = this.word.split(' '); return parts[parts.length - 1]!; }
  get firstWord(): string { return this.word.split(' ')[0]!; }
}

export const unstress = (phones: Phones): Phone[] => phones.map(([p]) => [p, 0] as const);

/** Give the word a primary stress: on its marked vowel, else on the first vowel. */
export function promote(phones: Phones): Phone[] {
  const marks = phones.map(([, s]) => s);
  if (marks.includes(1)) return [...phones];
  let target: number | null;
  if (marks.includes(2)) target = marks.length - 1 - [...marks].reverse().indexOf(2);
  else {
    const first = phones.findIndex(([p]) => VOWEL_SET.has(p));
    target = first < 0 ? null : first;
  }
  return phones.map(([p, s], i) => [p, i === target ? 1 : s] as const);
}

/** Resolve the stress class of every unit of a clause, right to left. */
export function stressClause(units: Unit[]): void {
  let primaryFollows = false;
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]!;
    const promoted = (): Phones => (unit.final !== null ? unit.final : promote(unit.phones));
    let phones: Phones;
    if (unit.kind === 'u') phones = unstress(unit.phones);
    else if (unit.kind === 'uf') phones = index === units.length - 1 ? promoted() : unstress(unit.phones);
    else if (unit.kind === 'ur') phones = primaryFollows ? unstress(unit.phones) : promoted();
    else if (unit.kind === 's') phones = primaryFollows ? unit.phones : promoted();
    else if (unit.kind === 'si') phones = !primaryFollows ? promoted() : index === 0 ? unit.phones : unstress(unit.phones);
    else if (unit.kind === 'pf') phones = index === units.length - 1 ? promoted() : unit.phones;
    else phones = unit.phones;
    unit.phones = [...phones];
    primaryFollows = primaryFollows || unit.phones.some(([, s]) => s === 1);
  }
  if (units.length && !units.some((u) => u.phones.some(([, s]) => s))) {
    for (const unit of [...units].reverse()) {
      if (unit.phones.some(([p]) => VOWEL_SET.has(p))) { unit.phones = promote(unit.phones); break; }
    }
  }
}

/** Adjust the end of each word to the beginning of the next. */
export function joinClause(units: Unit[]): void {
  for (let n = 0; n < units.length - 1; n++) {
    const unit = units[n]!, following = units[n + 1]!;
    if (!unit.phones.length || !following.phones.length || !VOWEL_SET.has(following.phones[0]![0])) continue;
    const [last, stress] = unit.phones[unit.phones.length - 1]!;
    const head = unit.phones.slice(0, -1);
    if (unit.lastWord === 'the' && last === 'ə') unit.phones = [...head, ['ɪ', stress]];
    else if (unit.lastWord === 'to' && last === 'ə') unit.phones = [...head, ['ʊ', stress]];
    else if (NO_LINK_BEFORE.has(following.firstWord)) continue;
    else if (last in SPLIT) unit.phones = [...head, [SPLIT[last]!, stress], ['ɹ', 0]];
    else if (RHOTIC.has(last)) unit.phones = [...unit.phones, ['ɹ', 0]];
    else if (last === 't' && FLAP_BEFORE_VOWEL.has(unit.word) && unit.phones.length > 1 && VOWEL_SET.has(unit.phones[unit.phones.length - 2]![0])) {
      unit.phones = [...head, ['ɾ', 0]];
    }
  }
}

/** Units of a clause as spoken words: an attached unit continues the one before. */
export function groups(units: Unit[]): Phone[][] {
  const out: Phone[][] = [];
  for (const unit of units) {
    if (unit.attach && out.length) out[out.length - 1] = [...out[out.length - 1]!, ...unit.phones];
    else out.push([...unit.phones]);
  }
  return out.filter((g) => g.length);
}
