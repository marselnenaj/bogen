import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { rawKey, rawPublicKey, sha256 } from '../src/release-key.ts';

/** A key made for the tests alone. Bogen's real release key is never made or read by a test. */
export function throwawayKey(): { privateKey: KeyObject; publicKey: string; raw: Buffer } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const publicKey = rawPublicKey(privateKey);
  return { privateKey, publicKey, raw: rawKey(publicKey)! };
}

/** Writes `<path>.sig` as scripts/release.mjs does: base64 of the signature. */
export function signInto(path: string, privateKey: KeyObject): void {
  writeFileSync(`${path}.sig`, `${sign(null, readFileSync(path), privateKey).toString('base64')}\n`);
}

export function checksumInto(path: string): void {
  writeFileSync(`${path}.sha256`, `${sha256(readFileSync(path))}  ${basename(path)}\n`);
}
