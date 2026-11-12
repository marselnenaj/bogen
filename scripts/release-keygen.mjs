#!/usr/bin/env node
// Makes a new Ed25519 release key pair.
//
//   node scripts/release-keygen.mjs ~/keys/bogen-release.pem
//
// Writes the private key as PKCS#8 PEM to the path you give, readable by you only (mode 600), and never over an
// existing file. Prints the public key, base64 of its 32 raw bytes, for RELEASE_PUBLIC_KEYS in
// packages/server/src/release-key.ts. The private key is never printed. Keep it outside the repository, back it
// up offline, and give its path to scripts/release.mjs in BOGEN_RELEASE_KEY_FILE.
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, openSync, writeSync, closeSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

/** Writes the pair; returns the public key in base64. */
export function makeReleaseKey(path) {
  const target = resolve(path);
  let ancestor = dirname(target);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, target));
  const inside = relative(root, actual);
  if (!inside.startsWith('..') && !inside.startsWith('/')) throw new Error('The release key must stay outside the repository, so that it can never be committed.');
  if (existsSync(target)) throw new Error(`${target} exists already. Pick a new path; this script never overwrites a key.`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ed25519');
  // `wx`: fail rather than follow a file or link that appeared in the meantime. Mode 600 from the first byte.
  const fd = openSync(target, 'wx', 0o600);
  try {
    writeSync(fd, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  } finally {
    closeSync(fd);
  }
  chmodSync(target, 0o600);
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = process.argv[2];
  if (!path || path.startsWith('-')) {
    console.error('Usage: node scripts/release-keygen.mjs <path for the private key, outside the repository>');
    process.exit(2);
  }
  try {
    const publicKey = makeReleaseKey(path);
    console.log(`Wrote the private key to ${resolve(path)} (mode 600). It was not printed.`);
    console.log(`Public key: ${publicKey}`);
    console.log("Put it first in RELEASE_PUBLIC_KEYS in packages/server/src/release-key.ts, and commit that line.");
  } catch (e) {
    console.error(`Refused: ${e.message}`);
    process.exit(1);
  }
}
