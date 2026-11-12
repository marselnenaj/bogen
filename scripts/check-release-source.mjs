#!/usr/bin/env node
// Read-only review of the tracked tree. Reports locations, never matched credentials or private values.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = args.indexOf('--private-patterns-file');
if (!(args.length === 0 || (args.length === 2 && option === 0))) throw new Error('Usage: check-release-source.mjs [--private-patterns-file /outside/repository.json]');
const privateValues = option >= 0 ? JSON.parse(readFileSync(args[option + 1], 'utf8')) : [];
if (!Array.isArray(privateValues) || privateValues.some((s) => typeof s !== 'string' || s.length < 4)) throw new Error('Private patterns must be an array of literal strings of at least four characters.');
const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const credential = /gh[pousr]_[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9_-]{16,}|figd_[A-Za-z0-9_-]{20,}|tskey-[a-z]+-[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const problems = [];
for (const file of files) {
  if (!/\.(?:[cm]?[jt]sx?|json|md|html|css|ya?ml|toml|sh|txt)$/.test(file) && !['LICENSE', 'PKGBUILD'].includes(file.split('/').at(-1))) continue;
  if (!existsSync(join(root, file))) continue;
  const lines = readFileSync(join(root, file), 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (privateValues.some((value) => line.includes(value))) problems.push(`${file}:${i + 1}: private identity`);
    // Only this explicit fixture holds fake credentials for redaction regression tests.
    if (file !== 'packages/server/test/report.test.ts' && credential.test(line)) problems.push(`${file}:${i + 1}: credential-like literal`);
  });
}
if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
else console.log(`Release-source check passed for ${files.length} tracked paths${privateValues.length ? ` and ${privateValues.length} private identity patterns` : ''}. This is a source hygiene check, not a full secret-history or security audit.`);
