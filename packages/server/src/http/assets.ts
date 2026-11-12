import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Storage } from '../storage.ts';
import { HttpError } from '../util.ts';

/** Images and fonts stay small. A video may be big, and goes to disk as it arrives instead of into memory. */
export const ASSET_LIMIT = 64 * 1024 * 1024;
export const VIDEO_LIMIT = 512 * 1024 * 1024;

export function assetLimit(mime: string): number {
  return mime.trim().toLowerCase().startsWith('video/') ? VIDEO_LIMIT : ASSET_LIMIT;
}

function tooBig(limit: number): HttpError {
  return new HttpError(413, `The body is larger than the limit of ${Math.round(limit / 1048576)} MB.`);
}

/** Streams a body into the asset folder, hashing on the way. Nothing named is written until it is complete. */
export async function receiveAsset(req: IncomingMessage, res: ServerResponse, storage: Storage, mime: string): Promise<{ name: string; src: string; url: string }> {
  const ext = Storage.extensionFor(mime);
  if (!ext) throw new HttpError(415, `Assets of type "${mime}" are not supported.`);
  const limit = assetLimit(mime);
  const refuse = (error: HttpError) => {
    // The rest of the upload is not worth reading: answer, then close.
    res.setHeader('Connection', 'close');
    return error;
  };
  if (Number(req.headers['content-length'] ?? 0) > limit) {
    req.resume();
    throw refuse(tooBig(limit));
  }
  const tmp = join(storage.home, 'assets', `.upload-${randomBytes(8).toString('hex')}`);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > limit) return done(tooBig(limit));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(req, meter, createWriteStream(tmp, { mode: 0o644 }));
  } catch (e) {
    await rm(tmp, { force: true });
    if (e instanceof HttpError) throw refuse(e);
    throw new HttpError(400, 'The upload did not finish.');
  }
  if (!size) {
    await rm(tmp, { force: true });
    throw new HttpError(400, 'The body is empty.');
  }
  const name = `${hash.digest('hex')}.${ext}`;
  if (await storage.hasAsset(name)) await rm(tmp, { force: true });
  else {
    await rename(tmp, storage.assetPath(name));
    storage.hooks.assetAdded?.(name);
  }
  return { name, src: `bogen-asset:${name}`, url: `/assets/${name}` };
}

/** A single `bytes=` range against this size. Null: serve it all. 'invalid': answer 416. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges, or a unit we do not know: the whole body is an allowed answer.
  if (!m) return null;
  if (!m[1] && !m[2]) return 'invalid';
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!suffix) return 'invalid';
    return size ? { start: Math.max(0, size - suffix), end: size - 1 } : 'invalid';
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}

/**
 * Asset names are content hashes, so a name never changes meaning: the ETag is the hash, a match is
 * always a 304, and caches may keep it for good. Behind a token it is private to that browser.
 */
export async function serveAsset(req: IncomingMessage, res: ServerResponse, storage: Storage, name: string, options: { privateCache: boolean }): Promise<void> {
  let info = await stat(storage.assetPath(name)).catch(() => null);
  if (!info) {
    // A paired device may have it. readAsset fetches it, and then it is on disk here too.
    if (!(await storage.readAsset(name))) throw new HttpError(404, 'No such asset.');
    info = await stat(storage.assetPath(name));
  }
  const etag = `"${name.split('.')[0]}"`;
  const headers: Record<string, string> = {
    'Content-Type': Storage.mimeOf(name), 'X-Content-Type-Options': 'nosniff',
    // Uploaded content, including SVG: it must never run as a page on this origin.
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'Cache-Control': `${options.privateCache ? 'private' : 'public'}, max-age=31536000, immutable`,
    ETag: etag, 'Accept-Ranges': 'bytes',
  };
  const match = req.headers['if-none-match'];
  if (match && (match === '*' || match.split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag))) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  const ifRange = req.headers['if-range'];
  const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.range, info.size);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` });
    res.end();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  res.writeHead(range ? 206 : 200, {
    ...headers, 'Content-Length': String(range ? end - start + 1 : info.size),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
  });
  if (req.method === 'HEAD' || !info.size) {
    res.end();
    return;
  }
  // Destroying the stream when the client goes away is what pipeline does, so seeking leaks nothing.
  await pipeline(createReadStream(storage.assetPath(name), { start, end }), res).catch(() => {});
}
