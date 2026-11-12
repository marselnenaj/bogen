import { open, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { NewNode } from '@bogen/core';
import { fetchPublic } from './net-guard.ts';
import type { Storage } from './storage.ts';
import { errorMessage } from './util.ts';

/**
 * What an agent is told wherever images come up. Bogen makes no images itself: the agent draws them, or brings
 * them from its own image tool, and stores them here.
 */
export const MAKE_IMAGES = 'Bogen has no image generator. Make images yourself: inline <svg> or CSS when that suits the subject, or your own image tool (such as Codex\'s built-in image generation or an image MCP server), then store the file with asset_upload and use its src.';

/** `bogen-gen:` once asked the server to generate an image. It does nothing now, and says so. */
const GEN = /bogen-gen:/i;
const GEN_IN_CSS = /url\(\s*["']?bogen-gen:/i;
export const NO_GENERATION = `bogen-gen: does nothing, so those images were left empty. ${MAKE_IMAGES} An <img> with no src stays on the canvas as a placeholder of its size until you set its src with layer_attrs.`;

export function mentionsGeneration(html: string): boolean {
  return GEN.test(html);
}

/** What the bytes say they are, so that nothing is stored under a type it is not. */
export function sniffImage(b: Uint8Array): string | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength);
  const ascii = (from: number, to: number) => buf.toString('latin1', from, to);
  if (buf.length > 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.length > 3 && buf.toString('hex', 0, 3) === 'ffd8ff') return 'image/jpeg';
  if (buf.length > 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 6 && /^GIF8[79]a$/.test(ascii(0, 6))) return 'image/gif';
  if (buf.length > 12 && ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'image/avif';
  return null;
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

// Never read from, whatever is in them.
const PROTECTED = ['.ssh', '.gnupg', '.aws', '.kube', '.password-store'];

/**
 * An image file an agent names by path, such as one its own image tool saved under ~/.codex. Only a regular file
 * under the home or temp folder, outside folders of keys, and only up to `limit` bytes. The caller checks the bytes.
 */
export async function readLocalImage(given: string, limit: number): Promise<Buffer> {
  const home = homedir();
  const expanded = given.startsWith('~/') ? join(home, given.slice(2)) : given;
  if (!isAbsolute(expanded)) throw new Error('path must be absolute, such as /home/you/Pictures/hero.png or ~/Pictures/hero.png.');
  const real = await realpath(resolve(expanded)).catch(() => {
    throw new Error(`There is no file at ${given}.`);
  });
  const roots = await Promise.all([home, tmpdir()].map((p) => realpath(p).catch(() => p)));
  if (!roots.some((root) => inside(root, real))) throw new Error(`${given} is outside the home and temp folders.`);
  if (PROTECTED.some((d) => inside(join(roots[0]!, d), real))) throw new Error(`${given} is in a protected folder.`);
  const handle = await open(real, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${given} is not a file.`);
    if (info.size > limit) throw new Error(`${given} is over the limit of ${limit / 1024 / 1024} MB.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

const REMOTE_IMAGE_LIMIT = 24;

/**
 * Prepares layer specs for writing: stores data URIs and public images as assets. A `bogen-gen:` image in a
 * style is taken out, as it would only be a broken request; html_write warns about it. Failures do not stop the
 * write. The layer stays, without its image, and the agent gets a warning.
 */
export async function resolveImages(storage: Storage, specs: NewNode[]): Promise<string[]> {
  const warnings = new Set<string>();
  const jobs: (() => Promise<void>)[] = [];
  let remote = 0;

  const visit = (node: NewNode) => {
    const src = node.src;
    if (src?.startsWith('data:')) {
      const match = /^data:(image\/(?:png|jpeg|webp|gif|avif)|video\/(?:mp4|webm));base64,(.+)$/s.exec(src);
      if (match) jobs.push(async () => {
        node.src = (await storage.putAsset(Buffer.from(match[2]!, 'base64'), match[1]!)).src;
      });
    } else if (/^https?:/i.test(src ?? '') && node.type === 'image' && remote < REMOTE_IMAGE_LIMIT) {
      remote++;
      jobs.push(async () => {
        try {
          const fetched = await fetchPublic(src!, { timeoutMs: 8000, accept: (t) => /^image\/(png|jpeg|webp|gif|avif)/.test(t) });
          node.src = (await storage.putAsset(fetched.bytes, fetched.contentType)).src;
        } catch (e) {
          warnings.add(`Kept ${src!.slice(0, 80)} as a remote link, it could not be stored: ${errorMessage(e)}`);
        }
      });
    }
    for (const [prop, value] of Object.entries(node.style ?? {})) {
      if (GEN_IN_CSS.test(value)) delete node.style![prop];
    }
    node.children?.forEach(visit);
  };
  specs.forEach(visit);

  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < jobs.length) await jobs[next++]!();
  }));
  return [...warnings];
}
