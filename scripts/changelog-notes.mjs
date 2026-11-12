#!/usr/bin/env node
// Prints one version's notes from docs/guide/changelog.md, as the body of its GitHub release.
//
//   node scripts/changelog-notes.mjs 0.1.0                 # to standard output
//   node scripts/changelog-notes.mjs 0.1.0 --output notes.md
//
// The section is everything under `## <version>` (or `## <version>, <anything>`) up to the next `## `. Relative
// links do not work in a release body, so each becomes a link into the version's tag on GitHub.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'https://github.com/marselnenaj/bogen';
const CHANGELOG = 'docs/guide/changelog.md';
const LINK = /(\]\()([^)\s]+)(\))/g;

/** `{ heading, body }` of `version`; throws when the changelog has no such section. */
export function versionNotes(text, version, tag = `v${version}`) {
  const lines = text.split('\n');
  const escaped = version.replace(/[.+]/g, '\\$&');
  const start = lines.findIndex((line) => new RegExp(`^## ${escaped}(,.*)?\\s*$`).test(line));
  if (start < 0) throw new Error(`${CHANGELOG} has no section "## ${version}".`);
  let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
  if (end < 0) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (!body) throw new Error(`The section "## ${version}" in ${CHANGELOG} is empty.`);
  const absolute = body.replace(LINK, (match, open, target, close) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) return match;
    const [path, anchor] = target.split('#');
    return `${open}${REPOSITORY}/blob/${tag}/${posix.normalize(posix.join(posix.dirname(CHANGELOG), path))}${anchor ? `#${anchor}` : ''}${close}`;
  });
  return { heading: lines[start].slice(3).trim(), body: `${absolute}\n` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const version = args.find((a) => !a.startsWith('--'));
  const output = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
  if (!version) {
    console.error('Usage: node scripts/changelog-notes.mjs <version> [--output <file>]');
    process.exit(2);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const { body } = versionNotes(readFileSync(join(root, CHANGELOG), 'utf8'), version);
    if (output) writeFileSync(output, body);
    else process.stdout.write(body);
  } catch (e) {
    console.error(`Refused: ${e.message}`);
    process.exit(1);
  }
}
