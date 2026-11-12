#!/usr/bin/env node
// Writes packages/core/src/exact-vocab.ts, the names and values Contract admits, from Exact's own compiler, for
// the experimental Exact export. Run it after moving EXACT_COMMIT (packages/core/src/exact-export.ts):
//
//   contract vocab --all --json > vocab.json      # a build of github.com/expo/exact at that commit
//   node scripts/gen-exact-vocab.mjs vocab.json packages/core/src/exact-vocab.ts
//
// Then run scripts/check-exact-export.ts against the same compiler.
import { readFileSync, writeFileSync } from 'node:fs';

const [, , input, output] = process.argv;
const v = JSON.parse(readFileSync(input, 'utf8'));
const styles = {};
for (const a of v.attributes) {
  if (!['style', 'shorthand', 'flex'].includes(a.kind) || a.name.startsWith('-')) continue;
  const rows = a.rows ?? [];
  const isEnum = a.kind === 'style' && rows.length && rows.every((r) => r.codec === 'enum');
  styles[a.name] = { codec: a.kind === 'style' ? [...new Set(rows.map((r) => r.codec))].join('|') : a.kind, values: isEnum ? rows[0].values : null };
}
const props = v.attributes.filter((a) => a.kind === 'prop' || a.kind === 'inverted-prop').map((a) => a.name).filter((n) => !n.startsWith('-') && !n.includes('.'));
const enums = Object.entries(styles).filter(([, s]) => s.values).sort(([a], [b]) => (a < b ? -1 : 1));
const numeric = Object.entries(styles).filter(([k, s]) => ['f32', 'u16', 'u32', 'u8', 'i32'].includes(s.codec) && k !== 'font-family').map(([k]) => k).sort();
const lengths = Object.entries(styles).filter(([, s]) => s.codec === 'dimension').map(([k]) => k).sort();
const typed = v.attributes.filter((a) => a.kind === 'prop' && ['bool', 'int', 'float'].includes(a.type) && !a.name.startsWith('-') && !a.name.includes('.')).sort((a, b) => (a.name < b.name ? -1 : 1));
const tags = [...v.tags.map((t) => t.name), 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].sort();

const wrap = (arr) => {
  const out = [];
  let line = '  ';
  for (const w of arr) {
    const t = `${JSON.stringify(w)}, `;
    if (line.length + t.length > 118) { out.push(line.trimEnd()); line = '  '; }
    line += t;
  }
  if (line.trim()) out.push(line.trimEnd());
  return out.join('\n');
};

const ts = `/**
 * What Contract admits, as Exact's compiler reports it with \`contract vocab --all --json\` at the commit in
 * EXACT_COMMIT (exact-export.ts). These are names and keyword values, the language's vocabulary, so that the
 * Exact export can leave out what the compiler would refuse, and say so, instead of writing it. Exact changes
 * daily: after moving EXACT_COMMIT, regenerate this file with scripts/gen-exact-vocab.mjs from that compiler's
 * vocabulary and run the optional compiler check (scripts/check-exact-export.ts).
 */

/** Style attributes: the CSS properties Contract spells as CSS does, shorthands included. */
export const EXACT_STYLES: ReadonlySet<string> = new Set([
${wrap(Object.keys(styles).sort())}
]);

/** Keyword properties and the values they take. */
export const EXACT_ENUMS: Readonly<Record<string, readonly string[]>> = {
${enums.map(([k, s]) => `  ${JSON.stringify(k)}: ${JSON.stringify(s.values).replace(/","/g, '", "')},`).join('\n')}
};

/** Properties whose value is a number: written without quotes when it has no unit. */
export const EXACT_NUMERIC: ReadonlySet<string> = new Set([
${wrap(numeric)}
]);

/** Length properties: a px value is written as a bare number, other units as a string. */
export const EXACT_LENGTHS: ReadonlySet<string> = new Set([
${wrap(lengths)}
]);

/** Element tags. h1 to h6 are text with a heading role. */
export const EXACT_TAGS: ReadonlySet<string> = new Set([
${wrap(tags)}
]);

/** Other attributes, such as alt, href, placeholder, and SVG's viewBox, d and points. */
export const EXACT_PROPS: ReadonlySet<string> = new Set([
${wrap(props.sort())}
]);

/** The props that are not text: written as a bare number or true and false. */
export const EXACT_PROP_TYPES: Readonly<Record<string, 'bool' | 'int' | 'float'>> = {
${typed.map((a) => `  ${JSON.stringify(a.name)}: '${a.type}',`).join('\n')}
};
`;
writeFileSync(output, ts);
console.log(`${Object.keys(styles).length} styles, ${enums.length} enums, ${tags.length} tags, ${props.length} props`);
