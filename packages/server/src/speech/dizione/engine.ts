/**
 * engine.py: the phonemizer, text -> spoken words of phones, clause by clause. Order of authority for one word:
 * inline pronunciation, the exception list (and names of several words written there), function words and groups,
 * the dictionary, regular endings and compounds, "-leigh" names and "-virus" words, then the unknown-word model.
 * The data is the phonemizer folder of tiny-voca: lexicon.tsv, align.json, g2p.json, g2p.npz, homographs.json.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Aligner } from './align.ts';
import { convert, fromText, settleStress } from './convert.ts';
import { Model } from './g2p.ts';
import { Homographs, type HomographData } from './homographs.ts';
import * as morphology from './morphology.ts';
import { Normalizer, type Token, type Word } from './normalize.ts';
import { key } from './py.ts';
import * as sentence from './sentence.ts';
import { Unit } from './sentence.ts';
import { tokenize, type Phone, type Phonemized, type Piece } from './symbols.ts';
import * as tables from './tables.ts';
import type { Entry } from './tables.ts';

const LEIGH = /(?<=[a-z]{2})leigh(?=s?$)/;
const VIRUS = ['viruses', 'virus'];
let letterNames: Map<string, Phone[]> | null = null;

/** The files the phonemizer reads from its data folder. */
export const DATA_FILES = ['lexicon.tsv', 'align.json', 'g2p.json', 'g2p.npz', 'homographs.json'] as const;

export class Phonemizer {
  private lexicon = new Map<string, string>();
  private aligner: Aligner;
  private model: Model;
  private homographs: Homographs;
  private functions = tables.functionWords();
  private phrases = tables.phrases();
  private phraseLength: number;
  private exceptions = tables.pronunciations('exceptions.txt');
  private names = tables.names('exceptions.txt');
  private nameStarts: Set<string>;
  private nameLength: number;
  private overrides = new Map<string, Entry>();
  private normalizer: Normalizer;
  private cache = new Map<string, [Phone[], string]>();

  /** `prefix` is put before each file name: Bogen keeps the files as `tiny-voca-lexicon.tsv` and so on. */
  constructor(directory: string, prefix = '') {
    const file = (name: string): string => join(directory, prefix + name);
    const lexicon = readFileSync(file('lexicon.tsv'), 'utf8');
    for (const line of lexicon.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab > 0) this.lexicon.set(line.slice(0, tab), line.slice(tab + 1));
    }
    this.aligner = new Aligner(JSON.parse(readFileSync(file('align.json'), 'utf8')));
    this.model = new Model(JSON.parse(readFileSync(file('g2p.json'), 'utf8')), readFileSync(file('g2p.npz')));
    this.homographs = new Homographs(JSON.parse(readFileSync(file('homographs.json'), 'utf8')) as HomographData);
    this.phraseLength = Math.max(1, ...[...this.phrases.keys()].map((k) => k.split('\u0000').length));
    this.nameStarts = new Set([...this.names.keys()].map((k) => k.split('\u0000')[0]!));
    this.nameLength = Math.max(1, ...[...this.names.keys()].map((k) => k.split('\u0000').length));
    this.normalizer = new Normalizer((word) => this.isWord(word));
  }

  // ---- single words ----

  private entry(word: string, entry: Entry): Phone[] {
    if (entry[0] === 'phones') return [...entry[1]];
    return convert(word, entry[1], this.aligner.align(word, entry[1]));
  }

  known(word: string): Phone[] | null {
    const override = this.overrides.get(word);
    if (override) return this.entry(word, override);
    const exception = this.exceptions.get(word);
    if (exception) return this.entry(word, exception);
    const text = this.lexicon.get(word);
    return text !== undefined ? fromText(text) : null;
  }

  private ordinary(word: string): Phone[] | null {
    if (word.length < 3 || !['s', 'es', 'ed', 'ing'].some((e) => this.lexicon.has(word + e))) return null;
    return this.known(word);
  }

  private guess(word: string): Phone[] {
    const spelling = this.model.spellable(word);
    const symbols = this.model.predict(spelling);
    symbols.forEach((symbol, k) => {
      if (symbol === 'R' && ![k - 1, k + 1].some((j) => j >= 0 && j < symbols.length && '012'.includes(symbols[j]!.slice(-1)))) symbols[k] = 'ER0';
    });
    if (!symbols.some((s) => '012'.includes(s.slice(-1)))) return this.spell(word);
    return sentence.promote(convert(spelling, symbols, this.aligner.align(spelling, symbols)));
  }

  spell(letters: string): Phone[] {
    letterNames ??= new Map([...tables.mapping('letters.txt')].map(([k, v]) => [k, fromText(v)]));
    const possessive = letters.toLowerCase().endsWith("'s");
    const names = [...(possessive ? letters.slice(0, -2) : letters).toLowerCase()].filter((c) => letterNames!.has(c)).map((c) => letterNames!.get(c)!);
    const out: Phone[] = [];
    names.forEach((name, index) => {
      for (const [phone, stress] of name) out.push([phone, stress && index < names.length - 1 ? 2 : stress]);
    });
    return possessive && out.length ? morphology.plural(out) : out;
  }

  isWord(word: string): boolean {
    return this.lexicon.has(word) || this.functions.has(word) || this.exceptions.has(word) || this.overrides.has(word);
  }

  private fromParts(word: string): [Phone[], string] | null {
    if (word.endsWith("'s") && word.length > 3) {
      const found = this.fromParts(word.slice(0, -2));
      return found && [morphology.plural(found[0]), found[1]];
    }
    if (LEIGH.test(word)) return this.word(word.replace(LEIGH, 'ley'));
    for (const tail of VIRUS) {
      const second = word.endsWith(tail) && word.length - tail.length > 2 ? this.known(tail) : null;
      if (second !== null) {
        const [first, source] = this.word(word.slice(0, -tail.length));
        const phones = sentence.promote(settleStress(morphology.compound(first, second)));
        return [phones, source === 'model' ? 'model' : 'ending'];
      }
    }
    return null;
  }

  word(word: string): [Phone[], string] {
    const cached = this.cache.get(word);
    if (cached) return cached;
    let phones = this.known(word);
    let source = 'dictionary';
    if (phones === null) {
      phones = morphology.derive(word, (s) => this.known(s), (s) => this.ordinary(s));
      source = 'ending';
      if (phones !== null) phones = settleStress(phones);
    }
    if (phones === null) {
      const found = this.fromParts(word);
      if (found) [phones, source] = found;
    }
    if (phones === null && word.endsWith("'s") && word.length > 3) { phones = morphology.plural(this.guess(word.slice(0, -2))); source = 'model'; }
    if (phones === null) { phones = this.guess(word); source = 'model'; }
    const result: [Phone[], string] = [phones, source];
    this.cache.set(word, result);
    return result;
  }

  // ---- sentences ----

  private units(words: Word[], places: number[], written: string[]): Unit[] {
    const units: Unit[] = [];
    let index = 0;
    while (index < words.length) {
      const token = words[index]!;
      if (token.phones !== null) units.push(new Unit(token.text, [...token.phones], 'p', null, token.attach, 'inline'));
      else if (token.spell) units.push(new Unit(token.text, this.spell(token.text), 'p', null, token.attach, 'letters'));
      else {
        let size = this.nameStarts.has(token.text) ? this.name(words, index) : 0;
        if (size) {
          const k = words.slice(index, index + size).map((w) => w.text);
          this.names.get(key(k))!.forEach((entry, position) => {
            units.push(new Unit(k[position]!, this.entry(k[position]!, entry), 'p', null, token.attach && position === 0, 'name'));
          });
          index += size;
          continue;
        }
        size = this.phrase(words, index);
        if (size) {
          const k = words.slice(index, index + size).map((w) => w.text);
          const [kind, forms, final] = this.phrases.get(key(k))!;
          if (forms.length === 1) units.push(new Unit(k.join(' '), forms[0]!, kind, final, token.attach, 'phrase'));
          else forms.forEach((form, position) => units.push(new Unit(k[position]!, form, kind, null, token.attach && position === 0, 'phrase')));
          index += size;
          continue;
        }
        if (this.overrides.has(token.text)) {
          units.push(new Unit(token.text, this.known(token.text)!, 'c', null, token.attach, 'override'));
        } else if (written.length && this.homographs.covers(token.text) && !this.exceptions.has(token.text)) {
          const [text, ending] = this.homographs.pronounce(token.text, written, places[index]!, token.attach);
          const phones = ending ? morphology.plural(fromText(text)) : fromText(text);
          units.push(new Unit(token.text, phones, 'c', null, token.attach, 'homograph'));
        } else if (this.functions.has(token.text)) {
          const [kind, form, final] = this.functions.get(token.text)!;
          units.push(new Unit(token.text, form, kind, final, token.attach, 'function'));
        } else {
          const [phones, source] = this.word(token.text);
          units.push(new Unit(token.text, phones, 'c', null, token.attach, source));
        }
      }
      index += 1;
    }
    return units;
  }

  private name(words: Word[], index: number): number {
    for (let size = Math.min(this.nameLength, words.length - index); size > 1; size--) {
      const span = words.slice(index, index + size);
      if (this.names.has(key(span.map((w) => w.text))) && span.every((w) => w.phones === null && !w.spell) && !span.slice(1).some((w) => w.attach)
        && !span.some((w) => this.overrides.has(w.text))) return size;
    }
    return 0;
  }

  private phrase(words: Word[], index: number): number {
    for (let size = Math.min(this.phraseLength, words.length - index); size > 1; size--) {
      const span = words.slice(index, index + size);
      if (span.slice(1).every((w) => w.phones === null && !w.spell && !w.attach) && span[0]!.phones === null && !span[0]!.spell
        && this.phrases.has(key(span.map((w) => w.text))) && !span.some((w) => this.overrides.has(w.text))) return size;
    }
    return 0;
  }

  /** Clauses and marks in order. */
  analyse(text: string): (['punct', string] | ['clause', Unit[]])[] {
    const stream: Token[] = this.normalizer.tokens(text);
    const written = stream.map((t) => (t.kind === 'punct' ? t.mark : t.raw || t.text || 'x'));
    const out: (['punct', string] | ['clause', Unit[]])[] = [];
    let words: Word[] = [], places: number[] = [];
    const flush = (): void => {
      if (!words.length) return;
      const units = this.units(words, places, written);
      sentence.stressClause(units);
      sentence.joinClause(units);
      out.push(['clause', units]);
      words = [];
      places = [];
    };
    stream.forEach((token, place) => {
      if (token.kind === 'punct') { flush(); out.push(['punct', token.mark]); }
      else { words.push(token); places.push(place); }
    });
    flush();
    return out;
  }

  pieces(text: string): Piece[] {
    return this.analyse(text).map(([kind, value]) => (kind === 'punct' ? [true, value] as const : [false, sentence.groups(value)] as const));
  }

  /** Text -> the tokens tiny-voca reads: symbols, ids and stress. */
  phonemize(text: string): Phonemized {
    if (!text.trim()) throw new Error('text must not be empty');
    return tokenize(this.pieces(text));
  }
}
