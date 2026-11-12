import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { sanitizeSvgMarkup } from '@bogen/core';
import { sniffImage } from './images.ts';
import { downscale, type Rgba } from './image-raster.ts';
import { toBase64, withEncoderPage } from './media.ts';
import type { Renderer } from './render.ts';
import type { Storage } from './storage.ts';
import type { TraceJob, TraceResult } from './vectorize-worker.ts';

/**
 * Vectorize: a raster image of the file traced into an editable SVG, on this computer, with imagetracerjs
 * (Unlicense). PNG decodes in the worker; JPEG, WebP, GIF and AVIF decode in the renderer's Chromium, with no
 * network. The markup is sanitized like any other SVG before it becomes a layer.
 */
export const VECTORIZE_DETAILS = ['low', 'medium', 'high'] as const;
export type VectorizeDetail = (typeof VECTORIZE_DETAILS)[number];
export const MIN_COLORS = 2;
export const MAX_COLORS = 64;

/** Tracer settings per level of detail. More detail keeps smaller shapes and follows edges closer, at a cost in paths. */
const DETAIL: Record<VectorizeDetail, { maxPixels: number; options: Record<string, number | boolean> }> = {
  low: { maxPixels: 120_000, options: { ltres: 4, qtres: 4, pathomit: 32, roundcoords: 1, blurradius: 2, blurdelta: 30, strokewidth: 1, rightangleenhance: true } },
  medium: { maxPixels: 250_000, options: { ltres: 1, qtres: 1, pathomit: 8, roundcoords: 1, strokewidth: 1, rightangleenhance: true } },
  high: { maxPixels: 500_000, options: { ltres: 0.5, qtres: 0.5, pathomit: 2, roundcoords: 2, strokewidth: 0.5, rightangleenhance: true } },
};

const TIMEOUT_MS = 60_000;
/** Markup larger than this would make a layer that slows every page it is on. */
export const MAX_SVG_BYTES = 4 * 1024 * 1024;

export interface VectorizeOptions { colors?: number; detail?: VectorizeDetail }
export interface VectorizeResult {
  svg: string;
  /** The image's own size in pixels, which is also the SVG's view box. */
  width: number;
  height: number;
  colors: number;
  paths: number;
  bytes: number;
}

let workerCode: Promise<{ file: string } | { code: string }> | undefined;

/** The built worker next to the CLI, or in development the worker bundled on first use. */
function workerSource(): Promise<{ file: string } | { code: string }> {
  workerCode ??= (async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const built = join(here, 'vectorize-worker.js');
    if (existsSync(built)) return { file: built };
    const esbuild = await import('esbuild');
    const result = await esbuild.build({ entryPoints: [join(here, 'vectorize-worker.ts')], bundle: true, format: 'cjs', platform: 'node', target: 'node22', write: false, logLevel: 'silent' });
    return { code: result.outputFiles[0]!.text };
  })().catch((err) => {
    workerCode = undefined;
    throw err;
  });
  return workerCode;
}

async function runTrace(job: TraceJob): Promise<TraceResult> {
  const source = await workerSource();
  const worker = 'file' in source ? new Worker(source.file) : new Worker(source.code, { eval: true });
  try {
    return await new Promise<TraceResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Tracing took longer than ${TIMEOUT_MS / 1000} s. Try less detail or fewer colours.`)), TIMEOUT_MS);
      worker.once('message', (m: { ok: true; result: TraceResult } | { ok: false; error: string }) => {
        clearTimeout(timer);
        if (m.ok) resolve(m.result);
        else reject(new Error(`Tracing failed: ${m.error}`));
      });
      worker.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      worker.postMessage(job);
    });
  } finally {
    void worker.terminate();
  }
}

/** Pixels of any image Chromium can show, scaled to at most `maxPixels`, in a page that reaches no network. */
async function decodeInBrowser(renderer: Renderer, bytes: Uint8Array, mime: string, maxPixels: number): Promise<{ rgba: Rgba; natural: { width: number; height: number } }> {
  return renderer.withBrowser((browser) => withEncoderPage(browser, async (page) => {
    const out = await page.evaluate(async (b64: string, type: string, max: number) => {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([raw], { type }));
      const ratio = Math.min(1, Math.sqrt(max / (bitmap.width * bitmap.height)));
      const w = Math.max(1, Math.floor(bitmap.width * ratio));
      const h = Math.max(1, Math.floor(bitmap.height * ratio));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      let s = '';
      for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
      return { w, h, natural: { width: bitmap.width, height: bitmap.height }, data: btoa(s) };
    }, toBase64(bytes), mime, maxPixels);
    return { rgba: { width: out.w, height: out.h, data: new Uint8ClampedArray(Buffer.from(out.data, 'base64')) }, natural: out.natural };
  }));
}

/** The tracer's own root, made one that fills its layer: the view box is in traced pixels, the layer sets the size. */
function fitViewBox(svg: string, traced: { width: number; height: number }): string {
  return svg.replace(/^<svg\b[^>]*>/, () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${traced.width} ${traced.height}" width="100%" height="100%">`);
}

/** Traces image bytes. Pure apart from the worker and, for formats other than PNG, the renderer. */
export async function vectorizeBytes(bytes: Uint8Array, renderer: Renderer | undefined, options: VectorizeOptions = {}): Promise<VectorizeResult> {
  const detail = DETAIL[options.detail ?? 'medium'];
  const colors = Math.round(Math.min(MAX_COLORS, Math.max(MIN_COLORS, options.colors ?? 8)));
  const mime = sniffImage(bytes);
  if (!mime) throw new Error('Only PNG, JPEG, WebP, GIF and AVIF images can be vectorized.');
  let job: TraceJob;
  let natural: { width: number; height: number } | undefined;
  if (mime === 'image/png' && !isInterlacedPng(bytes)) job = { png: bytes, colors, options: detail.options, maxPixels: detail.maxPixels };
  else {
    if (!renderer) throw new Error(`Vectorizing ${mime} needs the renderer.`);
    const decoded = await decodeInBrowser(renderer, bytes, mime, detail.maxPixels);
    natural = decoded.natural;
    job = { rgba: downscale(decoded.rgba, detail.maxPixels), colors, options: detail.options, maxPixels: detail.maxPixels };
  }
  const traced = await runTrace(job);
  const size = natural ?? { width: traced.width, height: traced.height };
  const svg = sanitizeSvgMarkup(fitViewBox(traced.svg, traced.traced));
  if (!svg || !/<path\b/.test(svg)) throw new Error('Tracing found no shapes in this image.');
  if (svg.length > MAX_SVG_BYTES) throw new Error(`The vector would be ${Math.round(svg.length / 1024)} KB, over the limit of ${MAX_SVG_BYTES / 1024 / 1024} MB. Try less detail or fewer colours.`);
  const fills = new Set([...svg.matchAll(/\bfill="([^"]+)"/g)].map((m) => m[1]));
  return { svg, width: size.width, height: size.height, colors: fills.size, paths: (svg.match(/<path\b/g) ?? []).length, bytes: svg.length };
}

function isInterlacedPng(bytes: Uint8Array): boolean {
  return bytes.length > 28 && bytes[28] === 1;
}

/** Traces one of the stored assets, by its `bogen-asset:` src. Nothing outside the asset store is fetched. */
export async function vectorizeAsset(storage: Storage, renderer: Renderer, src: string, options: VectorizeOptions = {}): Promise<VectorizeResult> {
  const name = /^bogen-asset:([a-f0-9]{64}\.[a-z0-9]{2,5})$/.exec(src.trim())?.[1];
  if (!name) throw new Error('Only images stored in Bogen can be vectorized. Upload the image first, with asset_upload or the Image section.');
  const asset = await storage.readAsset(name);
  if (!asset) throw new Error('That image is not in the asset store.');
  return vectorizeBytes(asset.bytes, renderer, options);
}
