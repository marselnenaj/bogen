/**
 * tables.py: the hand-written tables (data.ts). One entry per line, columns separated by tabs or by two or more
 * spaces, `#` starts a comment line. Pronunciations are phones with stress marks or CMUdict notation.
 */

import { TABLES } from './data.ts';
import { fromText, isArpabet } from './convert.ts';
import { key } from './py.ts';
import type { Phone } from './symbols.ts';

const COLUMNS = /\t+| {2,}/;
export const STRESS_CLASSES = new Set(['u', 'uf', 'ur', 's', 'ss', 'si', 'pf', 'p']);

export type Entry = readonly ['arpabet', string[]] | readonly ['phones', Phone[]];

export function* rows(name: string): Generator<[number, string[]]> {
  const text = TABLES[name];
  if (text === undefined) throw new Error(`no table ${name}`);
  let number = 0;
  for (const raw of text.split(/\r\n|\r|\n/)) {
    number++;
    const line = raw.trim();
    if (line && !line.startsWith('#')) yield [number, line.split(COLUMNS).map((c) => c.trim())];
  }
}

/** word -> [class, form, final form or null]. */
export function functionWords(): Map<string, [string, Phone[], Phone[] | null]> {
  const table = new Map<string, [string, Phone[], Phone[] | null]>();
  for (const [number, columns] of rows('function_words.txt')) {
    if (![3, 4].includes(columns.length) || !STRESS_CLASSES.has(columns[1]!)) throw new Error(`function_words.txt line ${number}`);
    table.set(columns[0]!, [columns[1]!, fromText(columns[2]!), columns.length === 4 ? fromText(columns[3]!) : null]);
  }
  return table;
}

/** (words) -> [class, forms, final form or null], keyed by `key(words)`. */
export function phrases(): Map<string, [string, Phone[][], Phone[] | null]> {
  const table = new Map<string, [string, Phone[][], Phone[] | null]>();
  for (const [number, columns] of rows('phrases.txt')) {
    if (![3, 4].includes(columns.length) || !STRESS_CLASSES.has(columns[1]!)) throw new Error(`phrases.txt line ${number}`);
    const forms = columns[2]!.split('|').map((part) => fromText(part));
    const words = columns[0]!.trim().split(/\s+/);
    if (forms.length > 1 && (columns[1] !== 'p' || forms.length !== words.length)) throw new Error(`phrases.txt line ${number}`);
    table.set(key(words), [columns[1]!, forms, columns.length === 4 ? fromText(columns[3]!) : null]);
  }
  return table;
}

function pronunciation(text: string): Entry {
  const symbols = text.trim().split(/\s+/).filter(Boolean);
  return isArpabet(symbols) ? ['arpabet', symbols] : ['phones', fromText(text)];
}

/** word -> pronunciation, for one-word rows. */
export function pronunciations(name: string): Map<string, Entry> {
  const table = new Map<string, Entry>();
  for (const [where, columns] of rows(name)) {
    if (columns.length !== 2) throw new Error(`${name} line ${where}: expected a word and its pronunciation`);
    if (columns[0]!.trim().split(/\s+/).length === 1) table.set(columns[0]!.toLowerCase(), pronunciation(columns[1]!));
  }
  return table;
}

/** Names of several words with one pronunciation per word, keyed by `key(words)`. */
export function names(name: string): Map<string, Entry[]> {
  const table = new Map<string, Entry[]>();
  for (const [where, columns] of rows(name)) {
    const words = columns[0]!.toLowerCase().trim().split(/\s+/);
    if (columns.length !== 2 || words.length < 2) continue;
    const parts = columns[1]!.split('|').map((p) => p.trim());
    if (parts.length !== words.length) throw new Error(`${name} line ${where}: one pronunciation per word`);
    table.set(key(words), parts.map(pronunciation));
  }
  return table;
}

/** Two-column table as a map (second column may be empty). */
export function mapping(name: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, columns] of rows(name)) out.set(columns[0]!, columns.length > 1 ? columns[1]! : '');
  return out;
}
