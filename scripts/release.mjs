#!/usr/bin/env node
// Makes a release of Bogen on this computer, from a clean checkout of its tag, and publishes nothing.
//
//   BOGEN_RELEASE_KEY_FILE=~/keys/bogen-release.pem npm run release
//   npm run release -- --dry-run          # the whole rehearsal, with a throwaway key unless one is named
//
// It builds, runs the typecheck and the documentation checks, packs the npm tarball, installs that tarball into a
// temporary prefix and runs `bogen --version`, `bogen serve` and `bogen doctor` from it against a temporary
// BOGEN_HOME, then writes into release/v<version>/:
//
//   assets/bogen-design-<v>.tgz                  the npm package, with .sha256 and .sig
//   assets/bogen-design-<v>.cdx.json             a CycloneDX SBOM from package-lock.json, with .sha256 and .sig
//   assets/bogen-release.json                    the manifest `bogen update` reads, with .sha256 and .sig
//   assets/bogen-design-<v>-provenance.intoto.json   commit, inputs, builder and every file's SHA-256, with .sig
//   notes.md                                     the release notes, from docs/guide/changelog.md
//   PKGBUILD                                     integrations/arch/PKGBUILD with this tarball's checksum
//
// A signature is base64 of the 64-byte Ed25519 signature of the file. The key is read from the file that --key or
// BOGEN_RELEASE_KEY_FILE names, which must lie outside the repository and be readable by its owner only; it is
// never printed or copied. A real release refuses a key that is not in RELEASE_PUBLIC_KEYS
// (packages/server/src/release-key.ts), a dirty tree, a HEAD that is not the tag v<version>, and a changelog
// section still marked unreleased. A dry run says what a real one would refuse, and goes on, into
// release/dry-run-v<version>/. The script ends by printing the steps after it: the tag push and the GitHub release.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { release as kernel, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPOSITORY, versionNotes } from './changelog-notes.mjs';
import { checkVersions } from './set-version.mjs';
import { isPlatform, licenseOf, nameOf, ORDER, shippedPackages } from './shipped-packages.mjs';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const KEY_ENVIRONMENT = 'BOGEN_RELEASE_KEY_FILE';
const KEY_SOURCE = 'packages/server/src/release-key.ts';
const NAME = 'bogen-design';
const MANIFEST = 'bogen-release.json';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const dryRun = flag('--dry-run');
const known = ['--dry-run', '--key', '--no-build', '--no-checks', '--no-smoke', '--update-pkgbuild', '--help'];
for (const a of args) if (a.startsWith('--') && !known.includes(a)) refuse(`Unknown option ${a}. Options: ${known.join(' ')}`);
if (flag('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
  process.exit(0);
}

function refuse(message) {
  console.error(`Refused: ${message}`);
  process.exit(1);
}

/** A real release stops here; a dry run notes it and goes on. */
function must(ok, message) {
  if (ok) return;
  if (!dryRun) refuse(message);
  console.log(`  dry run: a real release would refuse this: ${message}`);
}

const step = (title) => console.log(`\n== ${title}`);
const read = (command, argv, options = {}) => execFileSync(command, argv, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
function run(command, argv, options = {}) {
  console.log(`+ ${[command, ...argv].join(' ')}`);
  const done = spawnSync(command, argv, { cwd: root, stdio: 'inherit', ...options });
  if (done.status !== 0) throw new Error(`${command} ${argv.join(' ')} failed`);
}
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const writeChecksum = (file) => writeFileSync(`${file}.sha256`, `${sha256(readFileSync(file))}  ${basename(file)}\n`);

// ---------------------------------------------------------------- what is released, and with which key

const started = new Date();
const version = (() => {
  try {
    return checkVersions(root);
  } catch (e) {
    return refuse(e.message);
  }
})();
const tag = `v${version}`;
step(`Bogen ${version}${dryRun ? ', dry run' : ''}`);

const commit = read('git', ['rev-parse', 'HEAD']);
const dirty = read('git', ['status', '--porcelain']);
must(!dirty, `the tree is not clean:\n${dirty}`);
const tagged = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { cwd: root, encoding: 'utf8' }).stdout.trim();
must(tagged === commit, tagged ? `HEAD is not the commit of ${tag}` : `there is no tag ${tag}: make it on the commit to release with git tag -s ${tag}`);

const changelog = readFileSync(join(root, 'docs/guide/changelog.md'), 'utf8');
let notes;
try {
  notes = versionNotes(changelog, version, tag);
} catch (e) {
  refuse(e.message);
}
must(!/unreleased/i.test(notes.heading), `docs/guide/changelog.md still calls ${version} "${notes.heading}"`);

const trusted = [...readFileSync(join(root, KEY_SOURCE), 'utf8').matchAll(/RELEASE_PUBLIC_KEYS: readonly string\[\] = \[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/'([A-Za-z0-9+/=]{44})'/g)].map((k) => k[1]));
must(trusted.length > 0, `${KEY_SOURCE} has no public key, so this release could not be verified or updated to. Make one: node scripts/release-keygen.mjs`);

let throwaway = null;
process.once('exit', () => { if (throwaway) rmSync(throwaway, { recursive: true, force: true }); });
let keyPath = option('--key') || process.env[KEY_ENVIRONMENT];
if (!keyPath) {
  must(false, `name the signing key with --key or ${KEY_ENVIRONMENT}`);
  // Only a dry run gets here: a key that exists for this run alone, and is gone after it.
  throwaway = mkdtempSync(join(tmpdir(), 'bogen-release-key-'));
  keyPath = join(throwaway, 'throwaway.pem');
  writeFileSync(keyPath, generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  console.log('  dry run: signing with a throwaway key, deleted at the end');
}
keyPath = resolve(keyPath.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
const inRepo = !relative(root, keyPath).startsWith('..');
if (inRepo) refuse('the signing key must stay outside the repository');
if (!existsSync(keyPath)) refuse(`there is no signing key at ${keyPath}`);
if (statSync(keyPath).mode & 0o077) refuse(`the signing key must be readable by its owner only: chmod 600 ${keyPath}`);
let privateKey;
try {
  privateKey = createPrivateKey(readFileSync(keyPath));
} catch {
  refuse(`${keyPath} is not a private key in PEM form`);
}
if (privateKey.asymmetricKeyType !== 'ed25519') refuse(`${keyPath} is not an Ed25519 key`);
const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
const publicKey = spki.subarray(spki.length - 32).toString('base64');
must(trusted.includes(publicKey), `the signing key does not belong to a public key in ${KEY_SOURCE}`);
console.log(`  signing key: ${throwaway ? 'throwaway' : keyPath}, public key ${publicKey}`);

const out = join(root, 'release', dryRun ? `dry-run-${tag}` : tag);
const assets = join(out, 'assets');
if (dryRun) rmSync(out, { recursive: true, force: true });
else if (existsSync(out) && readdirSync(out).length) refuse(`${relative(root, out)}/ is not empty: move it away first, since everything in assets/ gets published`);
mkdirSync(assets, { recursive: true });

// ---------------------------------------------------------------- build and checks

if (!flag('--no-build')) {
  step('Build');
  run('npm', ['run', 'build']);
}
if (!flag('--no-checks')) {
  step('Checks');
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'check:docs']);
} else must(false, '--no-checks leaves out the typecheck and the documentation checks');

step('Pack');
const packed = read('node', ['scripts/release-npm.mjs', '--no-build']).split('\n').pop();
const tarballName = `${NAME}-${version}.tgz`;
if (basename(packed) !== tarballName) refuse(`npm pack made ${basename(packed)}, not ${tarballName}`);
const tarball = join(assets, tarballName);
cpSync(packed, tarball);
console.log(`  ${relative(root, tarball)}, ${(statSync(tarball).size / 1048576).toFixed(1)} MB`);

// ---------------------------------------------------------------- the smoke test

const freePort = () => new Promise((done) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => done(port));
  });
});

const fail = (message) => { throw new Error(message); };

async function smoke() {
  const prefix = mkdtempSync(join(tmpdir(), 'bogen-smoke-prefix-'));
  const home = mkdtempSync(join(tmpdir(), 'bogen-smoke-home-'));
  const port = await freePort();
  const env = { ...process.env, BOGEN_HOME: home, BOGEN_PORT: String(port), BOGEN_UPDATE_CHECK: 'off' };
  delete env.BOGEN_URL;
  delete env.BOGEN_TOKEN;
  let server = null;
  try {
    run('npm', ['install', '--global', '--prefix', prefix, '--no-fund', '--no-audit', tarball]);
    const bin = join(prefix, 'bin', 'bogen');
    const reported = read(bin, ['--version'], { env });
    if (!reported.startsWith(version)) fail(`bogen --version says ${reported}, not ${version}`);
    console.log(`  bogen --version: ${reported}`);
    // The icon sets beyond Lucide are data next to cli.js, read on first use; the package must carry every one.
    const sets = join(prefix, 'lib', 'node_modules', NAME, 'dist', 'icon-sets');
    const wanted = readdirSync(join(root, 'packages', 'core', 'src', 'icon-sets')).filter((f) => f.endsWith('.json'));
    const missing = wanted.filter((f) => !existsSync(join(sets, f)));
    if (!wanted.length || missing.length) fail(`the installed package has no ${missing.join(', ') || 'icon sets'} in dist/icon-sets`);
    console.log(`  icon sets: ${wanted.length} files in dist/icon-sets`);

    server = spawn(bin, ['serve', '--port', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    server.stdout.on('data', (d) => { log += d; });
    server.stderr.on('data', (d) => { log += d; });
    let status = null;
    for (let i = 0; i < 150 && !status; i++) {
      await new Promise((r) => setTimeout(r, 200));
      if (server.exitCode !== null) fail(`bogen serve stopped:\n${log}`);
      status = await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => (r.ok ? r.json() : null), () => null);
    }
    if (!status) fail(`bogen serve did not answer on port ${port}:\n${log}`);
    if (status.version !== reported) fail(`the server says ${status.version}, the command ${reported}`);
    const page = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    if (!/<div id="root">/.test(page)) fail('bogen serve does not serve the editor');
    console.log(`  bogen serve: ${status.version} answers on 127.0.0.1:${port} with the editor`);

    const doctor = spawnSync(bin, ['doctor', '--json'], { env, encoding: 'utf8', timeout: 120_000 });
    let checks;
    try {
      checks = JSON.parse(doctor.stdout);
    } catch {
      fail(`bogen doctor --json printed no JSON:\n${doctor.stdout}${doctor.stderr}`);
    }
    const state = (label) => checks.find((c) => c.label === label)?.state;
    for (const label of ['Node', 'Data folder', 'Server', 'Editor']) if (state(label) !== 'ok') fail(`bogen doctor: ${label} is ${state(label) ?? 'missing'}: ${JSON.stringify(checks.find((c) => c.label === label))}`);
    if (state('Server version') === 'fail') fail('bogen doctor says the server runs another build');
    const failed = checks.filter((c) => c.state === 'fail');
    console.log(`  bogen doctor: ${checks.length} checks, Node, data folder, server and editor ok${failed.length ? `; failing on this machine, not in the package: ${failed.map((c) => c.label).join(', ')}` : ''}`);
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    rmSync(prefix, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

if (!flag('--no-smoke')) {
  step('Smoke test of the packed tarball');
  await smoke().catch((e) => refuse(e.message));
} else must(false, '--no-smoke leaves out the smoke test');

// ---------------------------------------------------------------- SBOM, manifest, provenance, signatures

function signFile(file) {
  const data = readFileSync(file);
  const signature = sign(null, data, privateKey);
  if (!verify(null, data, createPublicKey(privateKey), signature)) refuse(`the signature of ${basename(file)} does not verify`);
  writeFileSync(`${file}.sig`, `${signature.toString('base64')}\n`);
}

const commitDate = read('git', ['log', '-1', '--format=%cI', 'HEAD']);
const purl = (name, v) => `pkg:npm/${name.replace(/^@/, '%40')}@${v}`;

function sbom() {
  const { packages, merged, label } = shippedPackages(root);
  const main = purl(NAME, version);
  const components = [...merged.values()].map(({ path, groups }) => {
    const entry = packages[path];
    const name = nameOf(path);
    const integrity = /^sha512-(.+)$/.exec(entry.integrity ?? '')?.[1];
    return {
      type: 'library', 'bom-ref': purl(name, entry.version), name, version: entry.version, purl: purl(name, entry.version),
      scope: 'required',
      licenses: [{ expression: licenseOf(root, path, entry) }],
      ...(integrity ? { hashes: [{ alg: 'SHA-512', content: Buffer.from(integrity, 'base64').toString('hex') }] } : {}),
      ...(entry.resolved ? { externalReferences: [{ type: 'distribution', url: entry.resolved }] } : {}),
      properties: [
        { name: 'bogen:shipped-in', value: ORDER.filter((k) => groups.has(k)).map((k) => label[k]).join(', ') },
        ...(isPlatform(entry) ? [{ name: 'bogen:platform-only', value: 'true' }] : []),
      ],
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
  const unique = [...new Map(components.map((c) => [c['bom-ref'], c])).values()];
  const digest = sha256(readFileSync(tarball));
  const uuid = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return {
    bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: `urn:uuid:${uuid}`, version: 1,
    metadata: {
      timestamp: commitDate,
      tools: { components: [{ type: 'application', name: 'scripts/release.mjs', version }] },
      component: {
        type: 'application', 'bom-ref': main, name: NAME, version, purl: main, licenses: [{ expression: 'GPL-3.0-or-later' }],
        hashes: [{ alg: 'SHA-256', content: digest }],
        externalReferences: [{ type: 'vcs', url: REPOSITORY }],
        properties: [{ name: 'bogen:file', value: tarballName }, { name: 'bogen:commit', value: commit }],
      },
    },
    components: unique,
    dependencies: [{ ref: main, dependsOn: unique.map((c) => c['bom-ref']) }],
  };
}

step('SBOM, manifest, provenance and signatures');
writeChecksum(tarball);
signFile(tarball);

const bom = join(assets, `${NAME}-${version}.cdx.json`);
const bomValue = sbom();
writeFileSync(bom, `${JSON.stringify(bomValue, null, 2)}\n`);
writeChecksum(bom);
signFile(bom);
console.log(`  ${basename(bom)}: ${bomValue.components.length} components from package-lock.json`);

const manifest = join(assets, MANIFEST);
writeFileSync(manifest, `${JSON.stringify({
  schema: 1, name: NAME, version, tag, date: commitDate,
  package: { file: tarballName, sha256: sha256(readFileSync(tarball)), size: statSync(tarball).size },
  notes: `${REPOSITORY}/releases/tag/${tag}`,
}, null, 2)}\n`);
writeChecksum(manifest);
signFile(manifest);

const firstLine = (command, argv) => {
  try {
    return read(command, argv).split('\n')[0];
  } catch {
    return undefined;
  }
};
const osName = (() => {
  try {
    return /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'))?.[1] ?? process.platform;
  } catch {
    return process.platform;
  }
})();
const provenanceName = `${NAME}-${version}-provenance.intoto.json`;
const provenance = join(assets, provenanceName);
const stamp = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');
const subjects = readdirSync(assets).sort()
  .filter((f) => f !== provenanceName && !f.endsWith('.sha256') && !f.endsWith('.sig'))
  .map((f) => ({ name: f, digest: { sha256: sha256(readFileSync(join(assets, f))) } }));
writeFileSync(provenance, `${JSON.stringify({
  _type: 'https://in-toto.io/Statement/v1',
  subject: subjects,
  predicateType: 'https://slsa.dev/provenance/v1',
  predicate: {
    buildDefinition: {
      buildType: `${REPOSITORY}/blob/${tag}/scripts/release.mjs`,
      externalParameters: { repository: REPOSITORY, ref: `refs/tags/${tag}`, dryRun, smokeTest: !flag('--no-smoke'), checks: !flag('--no-checks') },
      internalParameters: { dirty: Boolean(dirty) },
      resolvedDependencies: [
        { uri: `git+${REPOSITORY}@refs/tags/${tag}`, digest: { gitCommit: commit } },
        { name: 'package-lock.json', digest: { sha256: sha256(readFileSync(join(root, 'package-lock.json'))) } },
      ],
    },
    runDetails: {
      builder: {
        id: `${REPOSITORY}/blob/${tag}/docs/building.md`,
        version: Object.fromEntries(Object.entries({
          os: osName, kernel: kernel(), machine: process.arch, node: process.version,
          npm: firstLine('npm', ['--version']), git: firstLine('git', ['--version']),
        }).filter(([, v]) => v)),
      },
      metadata: { invocationId: `${tag}@${stamp(started)}`, startedOn: stamp(started), finishedOn: stamp(new Date()) },
    },
  },
}, null, 2)}\n`);
writeChecksum(provenance);
signFile(provenance);
console.log(`  ${provenanceName}: ${subjects.length} files, commit ${commit.slice(0, 12)}`);

// Everything once more, as a person checking the release would: digest, then signature with the public key alone.
const publicOnly = createPublicKey(privateKey);
for (const file of readdirSync(assets).filter((f) => !f.endsWith('.sha256') && !f.endsWith('.sig'))) {
  const data = readFileSync(join(assets, file));
  if (readFileSync(join(assets, `${file}.sha256`), 'utf8').split(/\s+/)[0] !== sha256(data)) refuse(`${file} does not match its .sha256`);
  if (!verify(null, data, publicOnly, Buffer.from(readFileSync(join(assets, `${file}.sig`), 'utf8').trim(), 'base64'))) refuse(`${file} does not match its .sig`);
}

// ---------------------------------------------------------------- notes and PKGBUILD

step('Release notes and PKGBUILD');
writeFileSync(join(out, 'notes.md'), notes.body);
console.log(`  ${relative(root, join(out, 'notes.md'))}: the "## ${notes.heading}" section of docs/guide/changelog.md`);
const fill = (text) => text.replace(/^pkgver=.*$/m, `pkgver=${version}`).replace(/^sha256sums=.*$/m, `sha256sums=('${sha256(readFileSync(tarball))}')`);
writeFileSync(join(out, 'PKGBUILD'), fill(readFileSync(join(root, 'integrations/arch/PKGBUILD'), 'utf8')));
console.log(`  ${relative(root, join(out, 'PKGBUILD'))}: sha256sums of ${tarballName}`);
if (flag('--update-pkgbuild')) {
  writeFileSync(join(root, 'integrations/arch/PKGBUILD'), fill(readFileSync(join(root, 'integrations/arch/PKGBUILD'), 'utf8')));
  console.log('  integrations/arch/PKGBUILD: the same checksum, to commit after the release');
}

if (dryRun) {
  // The verify command of this checkout, with the throwaway key: the check a person makes, end to end.
  step('bogen verify, from source, with this run\'s key');
  run('npx', ['tsx', 'packages/server/src/cli.ts', 'verify', provenance], { env: { ...process.env, BOGEN_RELEASE_TEST_PUBLIC_KEY: publicKey } });
}
if (throwaway) rmSync(throwaway, { recursive: true, force: true });

step(dryRun ? 'Dry run done. Nothing was published' : 'Release made. Nothing was published');
console.log(`Everything is in ${relative(root, out)}/. Publishing is a person's decision (docs/building.md):`);
console.log(`  git push origin ${tag}`);
console.log(`  gh release create ${tag} --repo marselnenaj/bogen --draft --verify-tag --title "Bogen ${version}" --notes-file ${relative(root, join(out, 'notes.md'))} ${relative(root, assets)}/*`);
console.log(`  gh release edit ${tag} --repo marselnenaj/bogen --draft=false --latest`);
