#!/usr/bin/env node
// The version in one place: this script writes it into every file that states it, and checks that they agree.
//
//   npm run version:set -- 0.2.0     # writes 0.2.0 everywhere
//   node scripts/set-version.mjs --check
//
// The files: the four package.json files, package-lock.json, the Omarchy plugin's manifest, the Arch PKGBUILD (its
// pkgrel goes back to 1 and its checksum to SKIP until scripts/release.mjs fills it in), and the README's badge. The
// changelog gets its section by hand, since only a person can say what is in it.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGES = ['package.json', 'packages/core/package.json', 'packages/server/package.json', 'apps/editor/package.json'];
const LOCK_ENTRIES = ['', 'packages/core', 'packages/server', 'apps/editor'];
const MANIFEST = 'integrations/omarchy/plugin/manifest.json';
const PKGBUILD = 'integrations/arch/PKGBUILD';
const README = 'README.md';
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** `{ file: version }` for every place that states the version. */
export function versions(root) {
  const read = (file) => readFileSync(join(root, file), 'utf8');
  const found = {};
  for (const file of PACKAGES) found[file] = JSON.parse(read(file)).version;
  const lock = JSON.parse(read('package-lock.json'));
  found['package-lock.json'] = lock.version;
  for (const entry of LOCK_ENTRIES) found[`package-lock.json ${entry || '(root)'}`] = lock.packages[entry]?.version;
  found[MANIFEST] = JSON.parse(read(MANIFEST)).version;
  found[PKGBUILD] = /^pkgver=(.*)$/m.exec(read(PKGBUILD))?.[1];
  found[README] = /badge\/version-([^-"]+(?:--[^-"]+)*)-[0-9a-f]{6}/.exec(read(README))?.[1]?.replace(/--/g, '-');
  return found;
}

/** The one version, or an error naming the files that disagree. */
export function checkVersions(root) {
  const found = versions(root);
  const distinct = new Set(Object.values(found));
  if (distinct.size !== 1 || distinct.has(undefined)) {
    throw new Error(`The versions disagree:\n${Object.entries(found).map(([f, v]) => `  ${f}: ${v ?? 'none found'}`).join('\n')}\nRun: npm run version:set -- <version>`);
  }
  return [...distinct][0];
}

export function setVersion(root, version) {
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a version such as 0.2.0.`);
  const edit = (file, change) => writeFileSync(join(root, file), change(readFileSync(join(root, file), 'utf8')));
  const json = (file, change) => edit(file, (text) => {
    const value = JSON.parse(text);
    change(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  });
  // package.json files keep their own layout: only the version line changes.
  for (const file of PACKAGES) edit(file, (text) => text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`));
  json('package-lock.json', (lock) => {
    lock.version = version;
    for (const entry of LOCK_ENTRIES) if (lock.packages[entry]) lock.packages[entry].version = version;
  });
  edit(MANIFEST, (text) => text.replace(/^(\s*"version":\s*")[^"]*(")/m, `$1${version}$2`));
  edit(PKGBUILD, (text) => text.replace(/^pkgver=.*$/m, `pkgver=${version}`).replace(/^pkgrel=.*$/m, 'pkgrel=1').replace(/^sha256sums=.*$/m, "sha256sums=('SKIP')"));
  // Shields.io writes a dash in a badge as two.
  edit(README, (text) => text.replace(/(badge\/version-)[^"]*?(-[0-9a-f]{6}")/, `$1${version.replace(/-/g, '--')}$2`).replace(/(alt="Version )[^"]*(")/, `$1${version}$2`));
  return checkVersions(root);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const arg = process.argv[2];
  try {
    if (!arg || arg === '--check') console.log(`Every file says ${checkVersions(root)}.`);
    else console.log(`Every file now says ${setVersion(root, arg)}. Add a "## ${arg}" section to docs/guide/changelog.md.`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
