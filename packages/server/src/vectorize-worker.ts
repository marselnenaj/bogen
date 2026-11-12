/// <reference path="./imagetracerjs.d.ts" />
import { parentPort } from 'node:worker_threads';
import tracer from 'imagetracerjs';
import { decodePng, downscale, type Rgba } from './image-raster.ts';

/**
 * Traces one raster image into SVG markup, off the server's main thread: a big image takes seconds, and the
 * server keeps answering everyone else meanwhile. Started by vectorize.ts, one job per worker.
 */
export interface TraceJob {
  /** PNG bytes, decoded here, or pixels decoded elsewhere. */
  png?: Uint8Array;
  rgba?: Rgba;
  colors: number;
  options: Record<string, number | boolean>;
  maxPixels: number;
}
export interface TraceResult { svg: string; width: number; height: number; traced: { width: number; height: number } }

export function trace(job: TraceJob): TraceResult {
  const full = job.rgba ?? decodePng(job.png!);
  const img = downscale(full, job.maxPixels);
  const options = { ...job.options, numberofcolors: job.colors, colorsampling: 2, viewbox: true, desc: false, layering: 0 };
  const data = tracer.imagedataToTracedata(img, options);
  // Fully transparent colours are the background showing through: no paths for them.
  data.layers = data.layers.map((layer, i) => (data.palette[i] && data.palette[i]!.a === 0 ? [] : layer));
  return { svg: tracer.getsvgstring(data, options), width: full.width, height: full.height, traced: { width: img.width, height: img.height } };
}

parentPort?.on('message', (job: TraceJob) => {
  try {
    parentPort!.postMessage({ ok: true, result: trace(job) });
  } catch (err) {
    parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
