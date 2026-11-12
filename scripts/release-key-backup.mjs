#!/usr/bin/env node
// Encrypted recovery copies, never plaintext keys in a release or repository. No key or recovery code is printed.
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outside = (path) => {
  const full = resolve(path); let ancestor = dirname(full);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = resolve(realpathSync(ancestor), relative(ancestor, full)), rel = relative(root, actual);
  if (!rel.startsWith('..') && !rel.startsWith('/')) throw new Error('Key/recovery files must stay outside the repository.');
  return full;
};
const privateFile = (path) => { const full = outside(path); if (lstatSync(full).isSymbolicLink()) throw new Error('Key/recovery files must not be symlinks.'); if (statSync(full).mode & 0o077) throw new Error('Key/recovery files must be owner-readable only (mode 600).'); return readFileSync(full); };
const put = (path, data) => { const full = outside(path); mkdirSync(dirname(full), { recursive: true, mode: 0o700 }); writeFileSync(full, data, { flag: 'wx', mode: 0o600 }); chmodSync(full, 0o600); };
const publicPart = (pem) => { const key = createPrivateKey(pem); if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 key.'); return createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'); };
export function createRecovery(keyFile, backupFile, codeFile) {
  for (const path of [backupFile, codeFile]) if (existsSync(outside(path))) throw new Error('Recovery output exists; nothing is overwritten.');
  const pem = privateFile(keyFile), publicKey = publicPart(pem), code = randomBytes(32).toString('base64url'), salt = randomBytes(16), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(code, salt, 32), iv);
  const encrypted = Buffer.concat([cipher.update(pem), cipher.final()]);
  put(codeFile, code + '\n');
  put(backupFile, JSON.stringify({ schema: 1, algorithm: 'aes-256-gcm', kdf: 'scrypt', publicKey, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encrypted: encrypted.toString('base64') }, null, 2) + '\n');
  if (recoverKey(backupFile, codeFile).publicKey !== publicKey) throw new Error('Recovery verification failed.');
  return { publicKey, verified: true };
}
export function recoverKey(backupFile, codeFile) {
  const b = JSON.parse(privateFile(backupFile));
  if (b.schema !== 1 || b.algorithm !== 'aes-256-gcm' || b.kdf !== 'scrypt') throw new Error('Unsupported recovery format.');
  const salt = Buffer.from(b.salt, 'base64'), iv = Buffer.from(b.iv, 'base64'), tag = Buffer.from(b.tag, 'base64'), encrypted = Buffer.from(b.encrypted, 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || encrypted.length > 4096) throw new Error('Invalid recovery file.');
  const code = privateFile(codeFile).toString('utf8').trim();
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(code, salt, 32), iv); decipher.setAuthTag(tag);
  const pem = Buffer.concat([decipher.update(encrypted), decipher.final()]), publicKey = publicPart(pem);
  if (publicKey !== b.publicKey) throw new Error('The recovered key does not match the recorded public key.');
  return { pem, publicKey };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, a, b, c] = process.argv.slice(2);
    if (action === 'create' && a && b && c) console.log(JSON.stringify(createRecovery(a, b, c)));
    else if ((action === 'verify' || action === 'restore') && a && b) {
      const recovered = recoverKey(a, b);
      if (action === 'restore') { if (!c) throw new Error('Name a new destination outside the repository.'); put(c, recovered.pem); }
      console.log(JSON.stringify({ publicKey: recovered.publicKey, verified: true, ...(action === 'restore' ? { restored: true } : {}) }));
    } else throw new Error('Usage: release-key-backup.mjs create <private.pem> <encrypted.json> <recovery-code.txt> | verify <encrypted.json> <code.txt> | restore <encrypted.json> <code.txt> <new-private.pem>');
  } catch (e) { console.error('Refused: ' + e.message); process.exitCode = 1; }
}
