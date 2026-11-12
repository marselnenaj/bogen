import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { Browser, Page } from 'puppeteer-core';

/**
 * Encoding that needs no native dependency of ours: WebCodecs inside the headless browser we already
 * need, or the person's own ffmpeg when there is one. `BOGEN_FFMPEG` is a path, or `none` to not use it.
 */
export function findFfmpeg(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.BOGEN_FFMPEG === 'none') return null;
  if (env.BOGEN_FFMPEG) return env.BOGEN_FFMPEG;
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    const path = join(dir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

const encodersCache = new Map<string, Set<string>>();

export function ffmpegEncoders(path: string): Set<string> {
  let known = encodersCache.get(path);
  if (!known) {
    known = new Set();
    const out = spawnSync(path, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10_000 });
    for (const line of (out.stdout ?? '').split('\n')) {
      const m = /^\s*[VAS][\w.]{5}\s+(\S+)/.exec(line);
      if (m) known.add(m[1]!);
    }
    encodersCache.set(path, known);
  }
  return known;
}

/** Runs ffmpeg with bytes on stdin. Its own message is kept for the error, without echoing paths. */
export function runFfmpeg(path: string, args: string[], input?: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg failed: ${stderr.trim().split('\n').at(-1) ?? code}`))));
    if (input) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(input);
    }
  });
}

/** A page where WebCodecs exists. It wants a secure context, and a blank page or our render origin is not one. */
export async function withEncoderPage<T>(browser: Browser, fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage();
  try {
    await page.evaluateOnNewDocument('globalThis.__name = (f) => f');
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (req.url().startsWith('https://bogen.encode/')) void req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>encode</title>' }).catch(() => {});
      else if (req.url().startsWith('data:')) void req.continue().catch(() => {});
      else void req.abort().catch(() => {});
    });
    await page.goto('https://bogen.encode/', { waitUntil: 'domcontentloaded' });
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}
