import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { EXTENSION_ROUTE, isExtensionOrigin } from '../extension-origin.ts';

export const COOKIE = 'bogen_token';

export interface GuardOptions {
  /** The actual port, known only after listening. */
  port: () => number;
  token?: string;
  /** Accepts loopback origins on any port, for the Vite dev server. */
  dev?: boolean;
  /** Extra exact origins, for a team server behind a proxy. */
  allowedOrigins?: string[];
  /** Bearer header only: no cookie and no query token. For the tailnet listener. */
  strict?: boolean;
  /** Origins that never get in, whatever else is allowed: the proxied pages of live site mode. */
  deniedOrigin?: (origin: string) => boolean;
  /** The phone listener, which checks requests itself: see `Phone.check`. Never set together with a token. */
  phone?: boolean;
}

export type Verdict = { ok: true } | { ok: false; status: number; message: string };

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

function splitHost(host: string): { name: string; port: string } {
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host.trim().toLowerCase());
  return m ? { name: m[1]!, port: m[2] ?? '' } : { name: '', port: '' };
}

function sameSecret(a: string, b: string): boolean {
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(a), hash(b));
}

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === COOKIE) return value;
  }
  return undefined;
}

export function tokenMatches(options: GuardOptions, candidate: string | null | undefined): boolean {
  return Boolean(options.token && candidate && sameSecret(options.token, candidate));
}

/**
 * Rules for every request and socket upgrade:
 * - On loopback, the Host must be a loopback name on our port, which stops DNS rebinding.
 * - With a token, the secret stops rebinding instead, so any Host may reach a server behind a proxy.
 * - A browser's Origin must be the same origin as the Host, whichever the mode. WebSockets get no CORS
 *   protection and neither do simple POSTs, so this is what keeps foreign pages out.
 * - CLI and MCP clients send no Origin. They pass, subject to the token if there is one.
 */
export function checkRequest(req: IncomingMessage, options: GuardOptions, url: URL): Verdict {
  const hostHeader = req.headers.host ?? '';
  const host = splitHost(hostHeader);
  if (options.strict && !options.token) return { ok: false, status: 503, message: 'Not ready.' };
  if (!options.token) {
    const portOk = options.dev || host.port === String(options.port());
    if (!LOOPBACK.has(host.name) || !portOk) return { ok: false, status: 403, message: 'This Host is not allowed.' };
  }
  const origin = req.headers.origin;
  // A browser extension is a foreign Origin. It gets the few routes made for it, on a server on this computer only,
  // and those check its pairing token themselves (extension.ts). Every other route still refuses it below.
  if (isExtensionOrigin(origin) && EXTENSION_ROUTE.test(url.pathname)) {
    if (options.token || options.strict || options.phone) return { ok: false, status: 403, message: 'Browser extensions pair only with Bogen on this computer.' };
    return { ok: true };
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return { ok: false, status: 403, message: 'Cross-site requests are not allowed.' };
  if (origin !== undefined && options.deniedOrigin?.(origin)) return { ok: false, status: 403, message: 'This Origin is not allowed.' };
  // Another port on this machine counts as the same site to a browser, and a page there sends no Origin on a simple GET.
  // It could not read the answer, but nothing of ours has a reason to answer it either.
  if (req.headers['sec-fetch-site'] === 'same-site' && !options.dev && !(origin && options.allowedOrigins?.includes(origin))) return { ok: false, status: 403, message: 'Requests from another site are not allowed.' };
  if (origin !== undefined && !originAllowed(origin, hostHeader, options)) return { ok: false, status: 403, message: 'This Origin is not allowed.' };

  if (options.token) {
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    // Browsers cannot set headers on a WebSocket, so upgrades may carry the token in the query.
    const query = req.headers.upgrade ? url.searchParams.get('token') : null;
    const passes = tokenMatches(options, bearer) || (!options.strict && (tokenMatches(options, cookieToken(req)) || tokenMatches(options, query)));
    if (!passes) {
      return { ok: false, status: 401, message: 'A valid token is required. Open /?token=<token> in a browser, or send Authorization: Bearer <token>.' };
    }
  }
  return { ok: true };
}

function originAllowed(origin: string, hostHeader: string, options: GuardOptions): boolean {
  if (options.allowedOrigins?.includes(origin)) return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (options.dev && LOOPBACK.has(parsed.hostname)) return true;
  return parsed.host === hostHeader.toLowerCase();
}
