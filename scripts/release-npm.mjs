#!/usr/bin/env node
// Lays out the npm package in release/npm and packs it. The CLI is one bundle, so the published
// package needs only what the bundle leaves external, not the workspace's own dependencies.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeShrinkwrap } from './shipped-packages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const server = join(root, 'packages', 'server');
const out = join(root, 'release', 'npm');
const source = JSON.parse(readFileSync(join(server, 'package.json'), 'utf8'));
const installed = (name) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;

if (!process.argv.includes('--no-build')) execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
if (!existsSync(join(server, 'dist', 'editor', 'index.html'))) throw new Error('The editor is not in packages/server/dist. Run npm run build first.');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(server, 'dist'), join(out, 'dist'), { recursive: true });
cpSync(join(root, 'integrations', 'omarchy'), join(out, 'integrations', 'omarchy'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
cpSync(join(root, 'LICENSE-EXCEPTION.md'), join(out, 'LICENSE-EXCEPTION.md'));
cpSync(join(root, 'README.md'), join(out, 'README.md'));
// The bundles keep no license comments, so the notices of what they contain travel as a file.
cpSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(out, 'THIRD_PARTY_NOTICES.md'));
cpSync(join(root, 'ASSET_PROVENANCE.md'), join(out, 'ASSET_PROVENANCE.md'));

const manifest = {
  name: source.name,
  version: source.version,
  description: 'Open source HTML/CSS design canvas for your own coding agent, over MCP',
  type: 'module',
  license: source.license,
  homepage: 'https://bogen.dev',
  repository: { type: 'git', url: 'git+https://github.com/marselnenaj/bogen.git' },
  bugs: { url: 'https://github.com/marselnenaj/bogen/issues' },
  bin: source.bin,
  files: ['dist', 'integrations', 'LICENSE-EXCEPTION.md', 'THIRD_PARTY_NOTICES.md', 'ASSET_PROVENANCE.md'],
  engines: source.engines,
  keywords: ['design', 'canvas', 'mcp', 'claude-code', 'codex', 'omarchy'],
  // Left external by scripts/build.mjs, or read from disk at run time, so they are the only runtime dependencies.
  dependencies: Object.fromEntries(['puppeteer-core', 'esbuild', 'tailwindcss'].map((name) => [name, installed(name)])),
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, 'npm-shrinkwrap.json'), `${JSON.stringify(runtimeShrinkwrap(root, manifest), null, 2)}\n`);

const tarball = execFileSync('npm', ['pack', '--silent'], { cwd: out, encoding: 'utf8' }).trim().split('\n').pop();
console.log(join(out, tarball));
