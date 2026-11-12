/**
 * Translation work in shards, for translators (people or models) who should not have to copy long English keys.
 *
 *   node scripts/i18n/work.ts bundle <dir> [--size 220] [--lang <code>…]
 *       Writes <dir>/manifest.json and <dir>/shard-NN.json: the messages to translate (all, or those the named
 *       languages lack), each under a short id, with where it is used. <dir>/languages.json says, per language, the
 *       plural categories a plural message must have.
 *   node scripts/i18n/work.ts merge <dir> [--lang <code>…]
 *       Reads <dir>/out/<code>/shard-NN.json ({ id: translation }) and merges them into
 *       apps/editor/src/i18n/locales/<code>.json. A translation that breaks a rule of check.ts (placeholders,
 *       plural forms, empty) is left out and reported, so it can be done again.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EDITOR_SRC, extract, sourceCatalog } from './extract.ts';
import { checkCatalog, FORMAT_LOCALES, pluralCategories } from './check.ts';

type Source = ReturnType<typeof sourceCatalog>;
type Value = string | Record<string, string>;

const LOCALES = join(EDITOR_SRC, 'i18n/locales');
const [command, dir, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const i = rest.indexOf(name);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < rest.length && !rest[j]!.startsWith('--'); j++) out.push(rest[j]!);
  return out;
};

function readCatalog(code: string): Record<string, Value> {
  const path = join(LOCALES, `${code}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
}

function writeCatalog(code: string, catalog: Record<string, Value>, source: Source): void {
  mkdirSync(LOCALES, { recursive: true });
  const sorted: Record<string, Value> = {};
  for (const key of Object.keys(source)) if (key in catalog) sorted[key] = catalog[key]!;
  writeFileSync(join(LOCALES, `${code}.json`), JSON.stringify(sorted, null, 1) + '\n');
}

const allCodes = Object.keys(FORMAT_LOCALES);

if (!dir || (command !== 'bundle' && command !== 'merge')) {
  console.error('Usage: node scripts/i18n/work.ts bundle|merge <dir> [--size n] [--lang code…]');
  process.exit(2);
}

const x = extract();
const source = sourceCatalog(x.messages);

if (command === 'bundle') {
  const size = Number(option('--size')[0] ?? 220);
  const langs = option('--lang');
  const wanted = Object.keys(source).filter((key) => !langs.length || langs.some((code) => !(key in readCatalog(code))));
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, string> = {};
  let shard = 0;
  for (let i = 0; i < wanted.length; i += size, shard++) {
    const name = `shard-${String(shard).padStart(2, '0')}`;
    const items = wanted.slice(i, i + size).map((key, j) => {
      const id = `${String(shard).padStart(2, '0')}-${String(j).padStart(3, '0')}`;
      manifest[id] = key;
      const english = source[key]!;
      const m = x.messages.get(key)!;
      const context = key.includes('\u0004') ? key.slice(0, key.indexOf('\u0004')) : undefined;
      return { id, ...(typeof english === 'string' ? { en: english } : { plural: english }), ...(context ? { context } : {}), where: m.refs.slice(0, 3) };
    });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(items, null, 1) + '\n');
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest) + '\n');
  writeFileSync(join(dir, 'languages.json'), JSON.stringify(Object.fromEntries(allCodes.map((c) => [c, pluralCategories(FORMAT_LOCALES[c]!)])), null, 1) + '\n');
  console.log(`${wanted.length} messages in ${shard} shards.`);
}

if (command === 'merge') {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Record<string, string>;
  const outDir = join(dir, 'out');
  const langs = option('--lang').length ? option('--lang') : existsSync(outDir) ? readdirSync(outDir) : [];
  for (const code of langs) {
    if (!allCodes.includes(code)) { console.log(`${code}: not a language`); continue; }
    const folder = join(outDir, code);
    if (!existsSync(folder)) continue;
    const catalog = readCatalog(code);
    const categories = pluralCategories(FORMAT_LOCALES[code]!);
    let added = 0;
    const rejected: string[] = [];
    for (const file of readdirSync(folder).filter((f) => f.endsWith('.json')).sort()) {
      let parsed: Record<string, Value>;
      try { parsed = JSON.parse(readFileSync(join(folder, file), 'utf8')); } catch (e) { rejected.push(`${file}: not JSON (${(e as Error).message})`); continue; }
      for (const [id, raw] of Object.entries(parsed)) {
        const key = manifest[id];
        if (!key || !(key in source)) { rejected.push(`${file}: unknown id ${id}`); continue; }
        let value: Value = raw;
        // Extra plural categories a translator added are dropped; the check below catches missing ones.
        if (typeof value === 'object' && value) value = Object.fromEntries(Object.entries(value).filter(([c]) => categories.includes(c)));
        const one = checkCatalog(code, { [key]: value }, { [key]: source[key]! });
        if (one.errors.length) { rejected.push(`${id}: ${one.errors.join('; ')}`); continue; }
        catalog[key] = value;
        added++;
      }
    }
    writeCatalog(code, catalog, source);
    const report = checkCatalog(code, readCatalog(code), source);
    console.log(`${code}: merged ${added}, rejected ${rejected.length}; now ${report.translated}/${Object.keys(source).length} (${(report.coverage * 100).toFixed(1)}%), same as English ${report.sameAsEnglish.length}, errors ${report.errors.length}`);
    for (const r of rejected.slice(0, 15)) console.log(`  rejected ${r}`);
  }
}
