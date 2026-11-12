/**
 * The interface translation audit. Run with Node 22.18 or newer from the repository root:
 *
 *   node scripts/i18n/audit.ts                      summary: messages, coverage per language, what is left
 *   node scripts/i18n/audit.ts --candidates [file…] English literals not yet wrapped, per file
 *   node scripts/i18n/audit.ts --missing <code>     messages the language lacks
 *   node scripts/i18n/audit.ts --json               everything, as JSON
 *   node scripts/i18n/audit.ts --write-source       writes apps/editor/src/i18n/source.json (the English inventory)
 *
 * Exits non-zero when a catalog breaks a rule (unknown key, placeholder mismatch, missing plural form, empty value),
 * so it can run as a check. Missing messages are reported, not fatal: they show in English.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDITOR_SRC, EXCLUDED_FILES, extract, sourceCatalog } from './extract.ts';
import { checkCatalog, type CatalogReport } from './check.ts';

const LOCALES = join(EDITOR_SRC, 'i18n/locales');
const args = process.argv.slice(2);

function codes(): string[] {
  const reg = readFileSync(join(EDITOR_SRC, 'i18n/registry.ts'), 'utf8');
  return [...reg.matchAll(/\{ code: '([^']+)'/g)].map((m) => m[1]!);
}

const x = extract();
const source = sourceCatalog(x.messages);

if (args[0] === '--write-source') {
  writeFileSync(join(EDITOR_SRC, 'i18n/source.json'), JSON.stringify(source, null, 1) + '\n');
  console.log(`Wrote ${Object.keys(source).length} messages.`);
  process.exit(0);
}

if (args[0] === '--candidates') {
  const only = args.slice(1).map((f) => f.replace(/^apps\/editor\/src\//, ''));
  const list = x.candidates.filter((c) => !only.length || only.includes(c.file));
  for (const c of list) console.log(`${c.file}:${c.line}\t${c.kind}\t${c.text}`);
  console.log(`\n${list.length} candidate${list.length === 1 ? '' : 's'}`);
  process.exit(0);
}

const reports: CatalogReport[] = [];
for (const code of codes()) {
  if (code === 'en') continue;
  const path = join(LOCALES, `${code}.json`);
  const catalog = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  reports.push(checkCatalog(code, catalog, source));
}

if (args[0] === '--missing') {
  const r = reports.find((r) => r.code === args[1]);
  if (!r) throw new Error(`No language ${args[1]}.`);
  for (const key of r.missing) console.log(key);
  process.exit(0);
}

const summary = {
  sourceFiles: x.files,
  messages: Object.keys(source).length,
  plurals: Object.values(source).filter((v) => typeof v === 'object').length,
  dynamicCalls: x.dynamic.length,
  candidatesLeft: x.candidates.length,
  intentionalEnglish: x.intentional.length,
  intentionalByReason: x.intentional.reduce<Record<string, number>>((acc, c) => ((acc[c.reason] = (acc[c.reason] ?? 0) + 1), acc), {}),
  candidatesByFile: Object.entries(x.candidates.reduce<Record<string, number>>((acc, c) => ((acc[c.file] = (acc[c.file] ?? 0) + 1), acc), {})).sort((a, b) => b[1] - a[1]),
  excludedFiles: EXCLUDED_FILES,
  extractionProblems: x.problems,
  languages: reports.map((r) => ({ code: r.code, translated: r.translated, missing: r.missing.length, sameAsEnglish: r.sameAsEnglish.length, errors: r.errors.length, coverage: r.coverage })),
};

if (args[0] === '--json') {
  console.log(JSON.stringify({ ...summary, details: reports }, null, 1));
} else {
  console.log(`${summary.messages} messages (${summary.plurals} plural) in ${summary.sourceFiles} files; ${summary.dynamicCalls} dynamic calls; ${summary.candidatesLeft} English literals unwrapped and unreviewed; ${summary.intentionalEnglish} reviewed as not interface text (i18n/untranslated.json).`);
  for (const p of x.problems) console.log(`problem: ${p}`);
  console.log('\ncode    translated  missing  same-as-English  errors  coverage');
  for (const r of summary.languages) console.log(`${r.code.padEnd(8)}${String(r.translated).padStart(10)}${String(r.missing).padStart(9)}${String(r.sameAsEnglish).padStart(17)}${String(r.errors).padStart(8)}${(r.coverage * 100).toFixed(1).padStart(9)}%`);
  for (const r of reports) for (const e of r.errors.slice(0, 20)) console.log(`${r.code}: ${e}`);
}
process.exit(reports.some((r) => r.errors.length) || x.problems.length ? 1 : 0);
