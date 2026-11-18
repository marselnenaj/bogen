import { createPrivateKey, randomBytes, sign as edSign, type X509Certificate } from 'node:crypto';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { b64u, canonical, newEd, signBytes, unb64u, verifyBytes, type KeyPair } from './crypto.ts';

/**
 * TLS 1.3 between team devices. Each device has a TLS key of its own, separate from its device signing key: the
 * device key never signs anything inside TLS (no cross-protocol use of one key), it only signs a short, tagged
 * statement "this TLS key speaks for this device until then", which travels in the certificate's
 * subjectAltName. A peer checks that statement against the device key the membership log names, so it pins the
 * device, not the TLS key, and the TLS key can be rotated without changing who the device is.
 *
 * Nobody's certificate is trusted by a CA. TLS 1.3 brings ephemeral key exchange, so a key stolen later does not
 * open traffic recorded earlier (forward secrecy), and nothing about a request is readable on the network.
 *
 * The certificate is made here, in a few lines of DER, so no X.509 library is needed.
 */

const ED25519_OID = Buffer.from([0x06, 0x03, 0x2b, 0x65, 0x70]);
const CN_OID = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const SAN_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x11]);
/** Signed by the device key, never by anything else: keeps this statement apart from ops, certs and envelopes. */
const TLS_TAG = 'bogen-tls-binding-v1|';
const URI_PREFIX = 'bogen-tls:v1.';
/** How long one TLS key may speak for a device, and when a device makes a new one. */
export const TLS_KEY_LIFE_MS = 30 * 86_400_000;
export const TLS_KEY_ROTATE_MS = 15 * 86_400_000;
export const SKEW_MS = 10 * 60_000;

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts: Buffer[]) => tlv(0x30, ...parts);
const utcTime = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return tlv(0x17, Buffer.from(`${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, 'ascii'));
};
const pem = (label: string, der: Buffer) => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END ${label}-----\n`;

export interface DeviceTls { key: string; cert: string; tlsPub: string; issued: number; expires: number; stored: StoredTls }
/** What a device keeps to make its certificate again after a restart. */
export interface StoredTls { key: KeyPair; issued: number }

/** The statement a device key signs for one TLS key. Exported for tests that forge certificates. */
export const bindingBytes = (device: string, tls: string, issued: number, expires: number) =>
  Buffer.from(TLS_TAG + canonical({ device, tls, issued, expires }));
export const bindingUri = (device: string, issued: number, expires: number, sig: string) => `${URI_PREFIX}${device}.${issued}.${expires}.${sig}`;

/** A certificate for a TLS key, self-signed by it, with the given subjectAltName URI (or none). Low level. */
export function certificateFor(tlsKey: KeyPair, uri: string | null, notBefore: number, notAfter: number): { key: string; cert: string } {
  const alg = seq(ED25519_OID);
  const name = seq(tlv(0x31, seq(CN_OID, tlv(0x0c, Buffer.from('bogen team device', 'utf8')))));
  const serial = randomBytes(16);
  // Positive and minimal in DER: the top bit clear, the first byte not zero.
  serial[0] = (serial[0]! & 0x7f) | 0x40;
  const parts = [
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    alg,
    name,
    seq(utcTime(new Date(notBefore)), utcTime(new Date(notAfter))),
    name,
    Buffer.concat([ED_SPKI, unb64u(tlsKey.pub)]),
  ];
  if (uri !== null) parts.push(tlv(0xa3, seq(seq(SAN_OID, tlv(0x04, seq(tlv(0x86, Buffer.from(uri, 'ascii'))))))));
  const tbs = seq(...parts);
  const pkcs8 = Buffer.concat([ED_PKCS8, unb64u(tlsKey.priv)]);
  const signature = edSign(null, tbs, createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
  return { key: pem('PRIVATE KEY', pkcs8), cert: pem('CERTIFICATE', seq(tbs, alg, tlv(0x03, Buffer.from([0]), signature))) };
}

/**
 * A certificate for this device's TLS key (made fresh unless one is given), self-signed by the TLS key, carrying
 * the device key's signature over "this TLS key, for this device, from issued until expires".
 */
export function deviceCertificate(device: KeyPair, opts: { tls?: StoredTls; now?: number; issued?: number } = {}): DeviceTls {
  const now = opts.now ?? Date.now();
  const tlsKey = opts.tls?.key ?? newEd();
  const issued = opts.tls?.issued ?? opts.issued ?? now;
  const expires = issued + TLS_KEY_LIFE_MS;
  const sig = signBytes(device.priv, bindingBytes(device.pub, tlsKey.pub, issued, expires));
  const made = certificateFor(tlsKey, bindingUri(device.pub, issued, expires, sig), issued - SKEW_MS, expires);
  return { ...made, tlsPub: tlsKey.pub, issued, expires, stored: { key: tlsKey, issued } };
}

/** The raw Ed25519 key a certificate carries, or null when it carries another kind. */
export function edKeyOf(cert: X509Certificate | undefined | null): string | null {
  if (!cert) return null;
  try {
    const der = cert.publicKey.export({ format: 'der', type: 'spki' });
    if (der.length !== 44 || !der.subarray(0, 12).equals(ED_SPKI)) return null;
    return b64u(der.subarray(12));
  } catch {
    return null;
  }
}

export interface PeerDevice { device: string; tls: string; issued: number; expires: number }

/**
 * The device a certificate speaks for: its TLS key must be certified by that device key, with a statement that
 * has not expired. The TLS handshake has already proven the peer holds the TLS key. Null for anything else,
 * including a certificate whose key is the device key itself (the old, single-key form).
 */
export type PeerCheck = { peer: PeerDevice } | { reason: 'none' | 'clock' | 'expired' | 'invalid' };

/** Like deviceOf, with why a certificate was turned down: a clock far apart gets its own answer. */
export function checkPeer(cert: X509Certificate | undefined | null, now = Date.now()): PeerCheck {
  const tls = edKeyOf(cert);
  if (!tls || !cert) return { reason: 'none' };
  const uris = (cert.subjectAltName ?? '').split(', ').filter((n) => n.startsWith(`URI:${URI_PREFIX}`));
  if (uris.length !== 1) return { reason: 'none' };
  const parts = uris[0]!.slice(`URI:${URI_PREFIX}`.length).split('.');
  if (parts.length !== 4) return { reason: 'invalid' };
  const [device, issuedText, expiresText, sig] = parts as [string, string, string, string];
  if (!/^\d{1,15}$/.test(issuedText) || !/^\d{1,15}$/.test(expiresText)) return { reason: 'invalid' };
  const issued = Number(issuedText), expires = Number(expiresText);
  if (device === tls) return { reason: 'invalid' };
  if (expires - issued > TLS_KEY_LIFE_MS || expires <= issued) return { reason: 'invalid' };
  if (!verifyBytes(device, bindingBytes(device, tls, issued, expires), sig)) return { reason: 'invalid' };
  if (issued > now + SKEW_MS) return { reason: 'clock' };
  if (expires < now) return { reason: 'expired' };
  return { peer: { device, tls, issued, expires } };
}

/**
 * The device a certificate speaks for: its TLS key must be certified by that device key, with a statement that
 * has not expired. The TLS handshake has already proven the peer holds the TLS key. Null for anything else,
 * including a certificate whose key is the device key itself (the old, single-key form).
 */
export function deviceOf(cert: X509Certificate | undefined | null, now = Date.now()): PeerDevice | null {
  const r = checkPeer(cert, now);
  return 'peer' in r ? r.peer : null;
}
export const PEER_REASONS: Record<'none' | 'clock' | 'expired' | 'invalid', string> = {
  none: 'A TLS key certified by a device key is needed.',
  invalid: 'The device certificate does not check out.',
  clock: 'The other device\'s clock is more than 10 minutes ahead of this one. Check the date and time on both.',
  expired: 'The other device\'s TLS key has expired, or this device\'s clock is far ahead. Check the date and time on both.',
};
export const peerDevice = (socket: TLSSocket, now?: number) => deviceOf(socket.getPeerX509Certificate(), now);

/** Keying material both ends of one TLS connection share, to bind a proof to that very connection. */
export const channelBinding = (socket: TLSSocket, label: string) => b64u(socket.exportKeyingMaterial(32, label, Buffer.alloc(0)));

export const TLS_OPTIONS = { minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' } as const;

export interface TlsPost { status: number; body: string; binding: string; peer: PeerDevice | null }

/**
 * POSTs JSON to a team device over TLS 1.3, after checking the answer comes from the device it should: a TLS key
 * certified by the expected device key. Nothing is sent before that check. `body` may depend on the connection
 * (the join proof does). `accept` may refuse a peer further (an older TLS key than one already seen).
 */
export function tlsPost(url: string, tls: DeviceTls, expect: string, path: string, body: (binding: string) => string, opts: { timeoutMs?: number; maxBytes?: number; bindingLabel?: string; accept?: (peer: PeerDevice) => boolean; now?: number } = {}): Promise<TlsPost> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const options: RequestOptions = {
      host: target.hostname.replace(/^\[|\]$/g, ''), port: Number(target.port || 443), path, method: 'POST',
      key: tls.key, cert: tls.cert, rejectUnauthorized: false, checkServerIdentity: () => undefined, agent: false,
      headers: { 'content-type': 'application/json' }, timeout: opts.timeoutMs ?? 20_000, ...TLS_OPTIONS,
    };
    let binding = '';
    let peer: PeerDevice | null = null;
    const req = httpsRequest(options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > (opts.maxBytes ?? 64 * 1024 * 1024)) { req.destroy(new Error('The answer is too large.')); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), binding, peer }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('No answer in time.')));
    req.on('error', reject);
    req.on('socket', (socket) => {
      const tlsSocket = socket as TLSSocket;
      const go = () => {
        const checked = checkPeer(tlsSocket.getPeerX509Certificate(), opts.now);
        if (!('peer' in checked)) { req.destroy(new Error(checked.reason === 'clock' || checked.reason === 'expired' ? PEER_REASONS[checked.reason] : 'Answered by another device than the one asked.')); return; }
        peer = checked.peer;
        if (peer.device !== expect || (opts.accept && !opts.accept(peer))) { req.destroy(new Error('Answered by another device than the one asked.')); return; }
        binding = channelBinding(tlsSocket, opts.bindingLabel ?? 'bogen-team-v2');
        req.end(body(binding));
      };
      if (tlsSocket.authorized !== undefined && tlsSocket.getPeerX509Certificate?.()) go();
      else tlsSocket.once('secureConnect', go);
    });
  });
}
