/**
 * homographs.py: words spelled alike and pronounced differently ("I read it yesterday" / "to read"). Hand rules first,
 * then a small linear classifier over the neighbouring words, with the weights from homographs.json.
 */

import { isAlpha, isDigit, isUpper } from './py.ts';
import { rows } from './tables.ts';

const CLASSES: [string, string][] = [
  ['TO', 'to'],
  ['DET', 'the a an this that these those every each no some any another such what which whose'],
  ['POSS', 'my your his her its our their'],
  ['SUBJ', 'i you he she it we they who'],
  ['OBJ', 'me him us them'],
  ['MODAL', "will would shall should can could may might must 'll 'd won't can't cannot couldn't shouldn't wouldn't let's please"],
  ['DO', "do does did don't doesn't didn't"],
  ['BE', "am is are was were be been being isn't aren't wasn't weren't i'm you're we're they're he's she's it's that's there's"],
  ['HAVE', "have has had having haven't hasn't hadn't i've you've we've they've"],
  ['NEG', 'not never'],
  ['PREP', 'of in on at by for from with into onto over under about after before between through during without within '
    + 'against among around across behind beside near upon toward towards as than like'],
  ['CONJ', 'and or but nor so yet if because although though while when where unless until since whether'],
  ['ADV', 'very too quite rather more most less least also just only even still always often sometimes usually again '
    + 'now then here there soon already almost'],
];
const TAG = new Map<string, string>();
for (const [name, words] of CLASSES) for (const word of words.split(' ')) TAG.set(word, name);
export const TOKEN_SOURCE = "[A-Za-z]+(?:'[A-Za-z]+)*|\\d+(?:[.,]\\d+)*|\\S";
const SENTENCE_END = new Set(['.', '?', '!']);
const WINDOW = 6;

export function tag(token: string): string {
  if (token === '<s>' || token === '</s>') return token;
  const first = [...token][0]!;
  if (!isAlpha(first)) return isDigit(first) ? 'NUM' : 'PUNCT';
  const lower = token.toLowerCase();
  const known = TAG.get(lower);
  if (known) return known;
  for (const [ending, name] of [["'s", 'POS'], ['ly', 'LY'], ['ing', 'ING'], ['ed', 'ED']] as const) {
    if (lower.endsWith(ending) && lower.length > ending.length + 1) return name;
  }
  if (lower.endsWith('s') && !lower.endsWith('ss') && lower.length > 3) return 'S';
  return isUpper(first) ? 'CAP' : 'W';
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function features(tokens: string[], index: number): string[] {
  const at = (offset: number): string => {
    const position = index + offset;
    return position >= 0 && position < tokens.length ? tokens[position]! : offset < 0 ? '<s>' : '</s>';
  };
  const p2 = at(-2), p1 = at(-1), n1 = at(1), n2 = at(2);
  const tp2 = tag(p2), tp1 = tag(p1), tn1 = tag(n1), tn2 = tag(n2);
  const out = ['tp1=' + tp1, 'tp2=' + tp2, 'tn1=' + tn1, 'tn2=' + tn2, 'tp2p1=' + tp2 + '+' + tp1, 'tp1n1=' + tp1 + '+' + tn1, 'tn1n2=' + tn1 + '+' + tn2];
  if (index === 0) out.push('first');
  else if (isUpper([...tokens[index]!][0]!)) out.push('cap');
  out.push('p1=' + p1.toLowerCase(), 'p2=' + p2.toLowerCase(), 'n1=' + n1.toLowerCase(), 'n2=' + n2.toLowerCase());
  const target = tokens[index]!.toLowerCase();
  const nearby = new Set(tokens.slice(Math.max(0, index - WINDOW), index + WINDOW + 1).filter((t) => isAlpha([...t][0]!)).map((t) => t.toLowerCase()));
  nearby.delete(target);
  for (const word of [...nearby].sort(byCodePoint)) out.push('w=' + word);
  return out;
}

const shared = (names: string[]): string[] => names.filter((n) => n[0] === 't' || n === 'first' || n === 'cap');

export function sentenceOf(tokens: string[], index: number): [string[], number] {
  let start = index;
  while (start > 0 && !SENTENCE_END.has(tokens[start - 1]!)) start--;
  let end = index;
  while (end < tokens.length && !SENTENCE_END.has(tokens[end]!)) end++;
  return [tokens.slice(start, end + 1), index - start];
}

const SKIP_FOR_BEFORE = new Set(['ADV', 'NEG', 'LY']);
const SKIP_FOR_AUX = new Set([...SKIP_FOR_BEFORE, 'SUBJ', 'OBJ', 'DET', 'POSS']);

function left(tokens: string[], index: number, skip: Set<string>): string {
  for (let position = index - 1; position > Math.max(index - 6, -1); position--) {
    const token = tokens[position]!;
    if (skip.has(tag(token))) continue;
    const lower = token.toLowerCase();
    return lower.endsWith("'ll") ? 'will' : lower.endsWith("'ve") ? 'have' : lower;
  }
  return '<s>';
}

type Condition = [string, Set<string>];

export function readRules(): Map<string, [string, Condition[]][]> {
  const rules = new Map<string, [string, Condition[]][]>();
  for (const [number, columns] of rows('homograph_rules.txt')) {
    if (columns.length !== 3) throw new Error(`homograph_rules.txt line ${number}`);
    const conditions: Condition[] = [];
    for (const part of columns[2]!.split(';')) {
      const trimmed = part.trim();
      const colon = trimmed.indexOf(':');
      const name = colon < 0 ? trimmed : trimmed.slice(0, colon);
      const words = colon < 0 ? '' : trimmed.slice(colon + 1);
      if (!['aux', 'before', 'next', 'near', 'first', 'joined'].includes(name) || (name === 'first') === Boolean(words.trim())) {
        throw new Error(`homograph_rules.txt line ${number}: bad condition`);
      }
      conditions.push([name, new Set(words.trim().split(/\s+/).filter(Boolean))]);
    }
    if (!rules.has(columns[0]!)) rules.set(columns[0]!, []);
    rules.get(columns[0]!)!.push([columns[1]!, conditions]);
  }
  return rules;
}

function holds(condition: string, words: Set<string>, tokens: string[], index: number, joined: boolean): boolean {
  if (condition === 'first') return index === 0;
  if (condition === 'joined') return joined && index > 0 && words.has(tokens[index - 1]!.toLowerCase());
  if (condition === 'aux') return words.has(left(tokens, index, SKIP_FOR_AUX));
  if (condition === 'before') return words.has(left(tokens, index, SKIP_FOR_BEFORE));
  if (condition === 'next') return words.has(index + 1 < tokens.length ? tokens[index + 1]!.toLowerCase() : '</s>');
  return tokens.slice(Math.max(0, index - WINDOW), index + WINDOW + 1).some((t) => words.has(t.toLowerCase()));
}

interface Sense { id: string; role: string; phones: string }
interface WordModel { kind: string; bias: number | number[]; weights: Record<string, number> | Record<string, number>[] }
export interface HomographData {
  words: Record<string, { senses: Sense[]; model: WordModel }>;
  pooled: { bias: number; weights: Record<string, number> };
  plural_bases?: string[];
}

const weight = (weights: Record<string, number>, name: string): number => (Object.hasOwn(weights, name) ? weights[name]! : 0.0);

export class Homographs {
  private words: HomographData['words'];
  private pooled: HomographData['pooled'];
  private pluralBases: Set<string>;
  private rules: Map<string, [string, Condition[]][]>;

  constructor(data: HomographData) {
    this.words = data.words;
    this.pooled = data.pooled;
    this.pluralBases = new Set(data.plural_bases ?? []);
    this.rules = readRules();
    for (const [word, wordRules] of this.rules) {
      const known = new Set(Object.hasOwn(this.words, word) ? this.words[word]!.senses.map((s) => s.id) : []);
      for (const [sense] of wordRules) if (!known.has(sense)) throw new Error(`homograph rule for ${word} names the unknown sense ${sense}`);
    }
  }

  has(word: string): boolean { return Object.hasOwn(this.words, word); }

  covers(word: string): boolean {
    return this.has(word) || (word.endsWith('s') && this.pluralBases.has(word.slice(0, -1)));
  }

  /** [phones as text, needs the -s ending]. */
  pronounce(word: string, tokens: string[], index: number, joined = false): [string, boolean] {
    if (this.has(word)) return [this.choose(word, tokens, index, joined).phones, false];
    const entry = this.words[word.slice(0, -1)]!;
    const adjective = entry.senses.find((s) => s.role === 'n');
    if (adjective && adjective.id === 'adj') return [entry.senses.find((s) => s.role === 'v')!.phones, true];
    return [this.choose(word.slice(0, -1), tokens, index, joined).phones, true];
  }

  scores(word: string, tokens: string[], index: number): number[] {
    const entry = this.words[word]!;
    const names = features(...sentenceOf(tokens, index));
    const model = entry.model;
    if (model.kind === 'noun-verb') {
      let verb = this.pooled.bias + shared(names).reduce((sum, n) => sum + weight(this.pooled.weights, n), 0);
      verb += (model.bias as number) + names.reduce((sum, n) => sum + weight(model.weights as Record<string, number>, n), 0);
      return entry.senses.map((s) => (s.role === 'v' ? verb : -verb));
    }
    const biases = model.bias as number[], weights = model.weights as Record<string, number>[];
    return biases.map((bias, k) => bias + names.reduce((sum, n) => sum + weight(weights[k]!, n), 0));
  }

  choose(word: string, tokens: string[], index: number, joined = false): Sense {
    const entry = this.words[word]!;
    const [sentence, position] = sentenceOf(tokens, index);
    for (const [sense, conditions] of this.rules.get(word) ?? []) {
      if (conditions.every(([name, words]) => holds(name, words, sentence, position, joined))) return entry.senses.find((s) => s.id === sense)!;
    }
    const scores = this.scores(word, tokens, index);
    let best = 0;
    for (let k = 1; k < scores.length; k++) if (scores[k]! > scores[best]!) best = k;
    return entry.senses[best]!;
  }
}
