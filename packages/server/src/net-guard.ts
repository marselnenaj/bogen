import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup as dnsLookupAsync } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, bits, 'ipv6');

export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!;
  const family = isIP(bare);
  if (family === 0) return true;
  // BlockList also matches IPv4-mapped IPv6 addresses against the IPv4 rules.
  return blocked.check(bare, family === 4 ? 'ipv4' : 'ipv6');
}

/** Resolves as usual, but refuses at connection time, so a rebinding DNS answer cannot slip through. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return callback(Object.assign(new Error(`${hostname} resolves to a private address.`), { code: 'EPRIVATE' }), '', 0);
    if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
};

function parsePublicUrl(raw: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw.slice(0, 80)}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http and https URLs can be fetched, not ${url.protocol}`);
  if (url.username || url.password) throw new Error('URLs with credentials are not fetched.');
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && isPrivateAddress(host)) throw new Error(`${host} is a private address and is not fetched.`);
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new Error(`${host} is a private host and is not fetched.`);
  return url;
}

/** For Chromium's request interception, where the browser connects by itself. */
export async function isPublicUrl(raw: string): Promise<boolean> {
  try {
    const url = parsePublicUrl(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) return true;
    const addresses = await dnsLookupAsync(host, { all: true });
    return addresses.length > 0 && !addresses.some((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

export interface FetchedBytes {
  bytes: Uint8Array;
  contentType: string;
  status: number;
}

export interface PublicFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Accepts this content type or throws. */
  accept?: (contentType: string) => boolean;
  /**
   * Lets the request reach this computer and its local network too. Only for a person at this machine who allowed
   * it for this address (see the data routes); never for an agent or another device. The limits stay.
   */
  allowPrivate?: boolean;
}

/** GET with an SSRF guard: public addresses only, on every redirect, with size and time limits. */
export async function fetchPublic(raw: string, options: PublicFetchOptions = {}): Promise<FetchedBytes> {
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  let current = raw;
  for (let hop = 0; hop < 5; hop++) {
    const url = parsePublicUrl(current, options.allowPrivate);
    const result = await requestOnce(url, maxBytes, options.timeoutMs ?? 10_000, options.headers ?? {}, options.allowPrivate ? undefined : guardedLookup);
    if ('location' in result) {
      current = new URL(result.location, url).toString();
      continue;
    }
    if (result.status < 200 || result.status >= 300) throw new Error(`Fetching ${url.host} returned status ${result.status}.`);
    if (options.accept && !options.accept(result.contentType)) throw new Error(`${url.host} returned ${result.contentType || 'an unknown type'}, which is not usable here.`);
    return result;
  }
  throw new Error('Too many redirects.');
}

function requestOnce(url: URL, maxBytes: number, timeoutMs: number, headers: Record<string, string>, lookup: LookupFunction | undefined): Promise<FetchedBytes | { location: string }> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, { ...(lookup ? { lookup } : {}), headers: { 'user-agent': 'bogen-design', ...headers }, timeout: timeoutMs }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ location: res.headers.location });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`The response is larger than ${Math.round(maxBytes / 1048576)} MB.`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ bytes: Buffer.concat(chunks), status, contentType: String(res.headers['content-type'] ?? '') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`Timed out fetching ${url.host}.`)));
    req.on('error', reject);
    // `timeout` above is about socket silence; this bounds a slow drip too.
    const deadline = setTimeout(() => req.destroy(new Error(`Timed out fetching ${url.host}.`)), timeoutMs * 3);
    deadline.unref();
    req.on('close', () => clearTimeout(deadline));
  });
}
