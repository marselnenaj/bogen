import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { b64u, fingerprint, hmac, KEY_TEXT, sameText, sha256, unb64u } from './crypto.ts';

/**
 * Invites: a one-time secret behind `#` in a link, so it never reaches a web server. The team only stores its hash.
 * Joining proves the secret with an HMAC over the joiner's keys and the request's nonce, so the secret itself is
 * never sent and a captured join cannot be played again (the proof is bound to its TLS connection).
 *
 * Link: `bogen://join/<team fingerprint>#<secret>.<hints>`, hints being base64url JSON with the team's key, its
 * name (unverified until connected), the inviting device's keys and the addresses to try.
 */

export interface InviteHints { team: string; name: string; device: { ed: string; x: string }; urls: string[]; role: string; by: string; expires: number }
export interface ParsedInvite { secret: Buffer; id: string; hints: InviteHints }

export const newInviteSecret = () => randomBytes(32);
export const inviteId = (secret: Uint8Array) => b64u(sha256(secret));

export function inviteLink(secret: Uint8Array, hints: InviteHints): string {
  return `bogen://join/${fingerprint(hints.team)}#${b64u(secret)}.${Buffer.from(JSON.stringify(hints)).toString('base64url')}`;
}

/**
 * Where a team device may be reached: https to an IP address, or to a Tailscale MagicDNS name, with a port.
 * No other host names, so a member cannot point your device at an arbitrary service; and since nothing is sent
 * before the other end proves its device key over TLS, a wrong address learns nothing.
 */
export function teamUrlOk(url: unknown): url is string {
  if (typeof url !== 'string' || url.length > 200) return false;
  const m = /^https:\/\/(\[[0-9a-fA-F:.]+\]|[0-9.]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net):([0-9]{2,5})$/.exec(url);
  if (!m) return false;
  const host = m[1]!.replace(/^\[|\]$/g, '');
  const port = Number(m[2]);
  if (!(port >= 1 && port <= 65535)) return false;
  return host.endsWith('.ts.net') || isIP(host) !== 0;
}

export function parseInvite(link: string): ParsedInvite {
  const text = link.trim();
  const m = /^(?:bogen:\/\/join\/|https:\/\/bogen\.dev\/join\/)([a-z2-7]{16})#([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]+)$/.exec(text);
  if (!m) throw new Error('That is not a Bogen invite link.');
  const secret = unb64u(m[2]!);
  let hints: InviteHints;
  try {
    hints = JSON.parse(Buffer.from(m[3]!, 'base64url').toString('utf8')) as InviteHints;
  } catch {
    throw new Error('The invite link is damaged.');
  }
  if (!hints || !KEY_TEXT.test(hints.team) || !hints.device || !KEY_TEXT.test(hints.device.ed) || !KEY_TEXT.test(hints.device.x)) throw new Error('The invite link is damaged.');
  if (fingerprint(hints.team) !== m[1]) throw new Error('The invite link does not match its team.');
  if (!Array.isArray(hints.urls) || hints.urls.length === 0 || hints.urls.length > 8 || !hints.urls.every(teamUrlOk)) throw new Error('The invite link names no address to reach the team.');
  if (typeof hints.name !== 'string' || hints.name.length > 100) throw new Error('The invite link is damaged.');
  return { secret, id: inviteId(secret), hints };
}

/**
 * What a joiner signs with the invite secret: its own keys and the TLS connection's exported keying material, so
 * a proof seen once is worth nothing on any other connection.
 */
export const joinProof = (secret: Uint8Array, person: string, device: string, binding: string) => hmac(secret, `bogen-join-v2|${person}|${device}|${binding}`);
export const proofMatches = (secret: Uint8Array, person: string, device: string, binding: string, proof: string) => typeof proof === 'string' && sameText(joinProof(secret, person, device, binding), proof);
