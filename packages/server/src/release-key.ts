import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { BUILD } from './version.ts';

/**
 * The release keys this build trusts, as base64 of the raw 32-byte Ed25519 public key: the current one first and,
 * while the key is being replaced, the next one. `scripts/release.mjs` reads this line and refuses a signing key
 * that does not belong to one of them. docs/building.md describes how a key is made,
 * backed up and replaced.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = ['VMw37sxKvTW71ViTFZJ8TwB2WYWjdr1r/CZ/tpbjVTc='];

/** The prefix of an Ed25519 public key in SPKI DER form; the raw key follows it. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function rawKey(text: string): Buffer | null {
  const bytes = Buffer.from(text.trim(), 'base64');
  return bytes.length === 32 && bytes.toString('base64') === text.trim() ? bytes : null;
}

export function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** Base64 of the raw public key of a key object, public or private. */
export function rawPublicKey(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

/**
 * The keys `bogen verify` and `bogen update apply` accept. Run from source, and only then, the tests may name their
 * own throwaway key in `BOGEN_RELEASE_TEST_PUBLIC_KEY`: a built bundle has no way to accept another key.
 */
export function trustedKeys(env: NodeJS.ProcessEnv = process.env): Buffer[] {
  const named = BUILD === 'dev' ? env.BOGEN_RELEASE_TEST_PUBLIC_KEY : undefined;
  const texts = named ? named.split(',') : RELEASE_PUBLIC_KEYS;
  return texts.map(rawKey).filter((k): k is Buffer => k !== null);
}

export type SignatureCheck = { ok: true; key: number } | { ok: false; reason: string };

/** A `.sig` holds base64 of the 64 signature bytes. Says which of `keys` made it, or why none did. */
export function checkSignature(keys: Buffer[], message: Uint8Array, signature: Uint8Array | string): SignatureCheck {
  if (!keys.length) return { ok: false, reason: 'this build of Bogen has no release key' };
  const text = typeof signature === 'string' ? signature : Buffer.from(signature).toString('utf8');
  const bytes = Buffer.from(text.trim(), 'base64');
  if (bytes.length !== 64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text.trim())) return { ok: false, reason: 'the signature file does not hold an Ed25519 signature' };
  const index = keys.findIndex((key) => {
    try {
      return verify(null, message, publicKeyObject(key), bytes);
    } catch {
      return false;
    }
  });
  return index >= 0 ? { ok: true, key: index } : { ok: false, reason: "the signature does not match the file and Bogen's release keys" };
}

export const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
