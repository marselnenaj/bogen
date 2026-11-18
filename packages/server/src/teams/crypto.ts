import {
  createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman,
  generateKeyPairSync, hkdfSync, randomBytes, sign as edSign, timingSafeEqual, verify as edVerify, type KeyObject,
} from 'node:crypto';
import { WORDS } from './wordlist.ts';

/**
 * Keys for teams. Ed25519 signs; the X25519 key a device publishes is kept for the relay (Phase 2). Traffic between
 * devices is TLS 1.3 with pinned device keys (tls.ts). Everything here is Node's own crypto; nothing new to trust.
 *
 * Public keys travel as base64url of their raw 32 bytes. Private keys are kept as base64url of their raw 32-byte
 * seed, in config.json (mode 0600), never sent anywhere.
 */

export const b64u = (bytes: Uint8Array): string => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
export const unb64u = (text: string): Buffer => Buffer.from(text, 'base64url');
export const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;

const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export interface KeyPair { pub: string; priv: string }
/** A device of a person: one key to sign, one to agree keys. */
export interface DeviceKeys { ed: KeyPair; x: KeyPair }
/** What others know of a device. */
export interface DevicePublic { ed: string; x: string; name: string }

function rawPublic(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'spki' });
  return b64u(der.subarray(der.length - 32));
}
function rawPrivate(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'pkcs8' });
  return b64u(der.subarray(der.length - 32));
}

export function newEd(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: rawPublic(publicKey), priv: rawPrivate(privateKey) };
}
export function newX(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { pub: rawPublic(publicKey), priv: rawPrivate(privateKey) };
}
export function newDeviceKeys(): DeviceKeys {
  return { ed: newEd(), x: newX() };
}

/** An Ed25519 key pair from a 32-byte seed, so that a recovery phrase gives back the same person key. */
export function edFromSeed(seed: Uint8Array): KeyPair {
  if (seed.length !== 32) throw new Error('A seed has 32 bytes.');
  const priv = createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  return { pub: rawPublic(createPublicKey(priv)), priv: b64u(seed) };
}

const edPriv = (priv: string) => createPrivateKey({ key: Buffer.concat([ED_PKCS8, unb64u(priv)]), format: 'der', type: 'pkcs8' });
const pubCache = new Map<string, KeyObject>();
const edPub = (pub: string) => {
  let key = pubCache.get(pub);
  if (!key) {
    key = createPublicKey({ key: Buffer.concat([ED_SPKI, unb64u(pub)]), format: 'der', type: 'spki' });
    if (pubCache.size > 10_000) pubCache.clear();
    pubCache.set(pub, key);
  }
  return key;
};

export function signBytes(priv: string, data: Uint8Array): string {
  return b64u(edSign(null, data, edPriv(priv)));
}
export function verifyBytes(pub: string, data: Uint8Array, sig: string): boolean {
  if (!KEY_TEXT.test(pub) || typeof sig !== 'string' || sig.length !== 86) return false;
  try {
    return edVerify(null, data, edPub(pub), unb64u(sig));
  } catch {
    return false;
  }
}

/** JSON with keys sorted at every level, so that a signature covers one exact byte string. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Numbers in signed data must be finite.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export const sha256 = (data: Uint8Array | string): Buffer => createHash('sha256').update(data).digest();

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
export function base32(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += BASE32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** A short id of a public key, the way Syncthing derives a device id from its certificate. */
export function fingerprint(pub: string): string {
  return base32(sha256(unb64u(pub))).slice(0, 16);
}

/** Six words both sides can read out to check they are in the same team with the same person. */
export function safetyPhrase(teamPub: string, personPub: string): string[] {
  const [a, b] = [teamPub, personPub];
  const digest = sha256(`bogen-safety-v1|${a}|${b}`);
  const words: string[] = [];
  for (let i = 0; i < 6; i++) words.push(WORDS[((digest[i * 2]! << 8) | digest[i * 2 + 1]!) & 2047]!);
  return words;
}

/** 12 words for 128 bits, with BIP-39's checksum, and the person key they give back. */
export function newRecoveryPhrase(): string[] {
  return phraseFromEntropy(randomBytes(16));
}
export function phraseFromEntropy(entropy: Uint8Array): string[] {
  if (entropy.length !== 16) throw new Error('A recovery phrase holds 16 bytes.');
  const check = sha256(entropy)[0]! >> 4;
  let bits = '';
  for (const byte of entropy) bits += byte.toString(2).padStart(8, '0');
  bits += check.toString(2).padStart(4, '0');
  const out: string[] = [];
  for (let i = 0; i < 12; i++) out.push(WORDS[parseInt(bits.slice(i * 11, i * 11 + 11), 2)]!);
  return out;
}
export function entropyFromPhrase(words: readonly string[]): Buffer {
  const clean = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (clean.length !== 12) throw new Error('A recovery phrase has 12 words.');
  let bits = '';
  for (const word of clean) {
    const index = WORDS.indexOf(word);
    if (index < 0) throw new Error(`"${word}" is not a word of the recovery list.`);
    bits += index.toString(2).padStart(11, '0');
  }
  const entropy = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) entropy[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  if ((sha256(entropy)[0]! >> 4) !== parseInt(bits.slice(128), 2)) throw new Error('These words do not check out. Look for a word written down wrong.');
  return entropy;
}
export function personKeyFromPhrase(words: readonly string[]): KeyPair {
  const entropy = entropyFromPhrase(words);
  return edFromSeed(new Uint8Array(hkdfSync('sha256', entropy, 'bogen-person-v1', 'person key', 32)));
}

export function hmac(secret: Uint8Array, data: string): string {
  return b64u(createHmac('sha256', secret).update(data).digest());
}
export function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
