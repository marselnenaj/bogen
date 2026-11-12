import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BogenDoc } from '@bogen/core';
import type { Browser, Page } from 'puppeteer-core';
import { ffmpegEncoders, findFfmpeg, toBase64, withEncoderPage } from './media.ts';
import type { Renderer, Target } from './render.ts';

/**
 * Video of a frame, made one picture at a time: every animation is paused and set to an exact moment,
 * then the page is captured. The same document therefore gives the same frames, however slow the
 * machine is. A GIF or an embedded page runs on its own clock, and the report says when one is there.
 */
export interface VideoOptions {
  format: 'mp4' | 'webm';
  /** Seconds. */
  duration?: number;
  fps?: number;
  scale?: number;
  /** `ffmpeg` or `webcodecs`. By default ffmpeg if it is there. */
  encoder?: 'ffmpeg' | 'webcodecs';
  onFrame?: (done: number, total: number) => void;
}

export interface VideoResult {
  bytes: Uint8Array;
  mime: string;
  ext: string;
  encoder: 'ffmpeg' | 'webcodecs';
  codec: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  /** Things in the frame that do not follow the export's clock. */
  notDeterministic: string[];
}

export const MAX_VIDEO_SECONDS = 120;
export const MAX_VIDEO_DIMENSION = 7680;

/** Runs in the rendered page. */
function installSeek(): { animations: number; shaders: number; videos: number; gifs: number; embeds: number } {
  const w = window as unknown as {
    __bogenSeek: (ms: number) => Promise<void>;
    __bogenSeekShaders?: (ms: number) => Promise<void>;
  };
  // A timer too, as a page behind another one gets no animation frames.
  const nextFrame = () => new Promise<void>((resolve) => {
    const limit = setTimeout(resolve, 250);
    requestAnimationFrame(() => {
      clearTimeout(limit);
      resolve();
    });
  });
  w.__bogenSeek = async (ms: number) => {
    for (const animation of document.getAnimations()) {
      animation.pause();
      animation.currentTime = ms;
    }
    for (const svg of document.querySelectorAll('svg')) {
      svg.pauseAnimations();
      svg.setCurrentTime(ms / 1000);
    }
    await Promise.all([...document.querySelectorAll('video')].map((video) => new Promise<void>((resolve) => {
      video.pause();
      const length = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const at = length ? (ms / 1000) % length : 0;
      if (!length || Math.abs(video.currentTime - at) < 0.0005) return resolve();
      const done = () => {
        clearTimeout(limit);
        video.removeEventListener('seeked', done);
        resolve();
      };
      const limit = setTimeout(done, 3000);
      video.addEventListener('seeked', done);
      video.currentTime = at;
    })));
    await w.__bogenSeekShaders?.(ms);
    await nextFrame();
    await nextFrame();
  };
  for (const animation of document.getAnimations()) animation.pause();
  return {
    animations: document.getAnimations().length,
    shaders: document.querySelectorAll('[data-shader]').length,
    videos: document.querySelectorAll('video').length,
    gifs: [...document.images].filter((img) => /\.gif($|\?)/i.test(img.src)).length,
    embeds: document.querySelectorAll('iframe').length,
  };
}

function evenSize(rect: { width: number; height: number }, scale: number): { width: number; height: number; scale: number } {
  let s = scale;
  const longest = Math.max(rect.width, rect.height) * s;
  if (longest > MAX_VIDEO_DIMENSION) s *= MAX_VIDEO_DIMENSION / longest;
  const even = (v: number) => {
    const n = Math.max(2, Math.ceil(v * s));
    return n + (n % 2);
  };
  return { width: even(rect.width), height: even(rect.height), scale: s };
}

export interface FrameSink {
  push(png: Uint8Array, index: number): Promise<void>;
  /** Finishes and gives the file. */
  finish(): Promise<{ bytes: Uint8Array; codec: string }>;
  abort(): void;
}

export async function ffmpegSink(path: string, options: { format: 'mp4' | 'webm' | 'gif'; fps: number }): Promise<FrameSink> {
  const encoders = ffmpegEncoders(path);
  const dir = await mkdtemp(join(tmpdir(), 'bogen-video-'));
  const output = join(dir, `out.${options.format}`);
  let codec: string;
  let args: string[];
  if (options.format === 'gif') {
    // One palette for the whole film, made from what changes between frames, so flat designs stay clean.
    codec = 'gif';
    args = ['-filter_complex', 'split[a][b];[a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle', '-loop', '0'];
  } else if (options.format === 'mp4') {
    if (encoders.has('libx264')) {
      codec = 'h264';
      args = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    } else throw new Error('This ffmpeg has no H.264 encoder.');
  } else if (encoders.has('libvpx-vp9')) {
    codec = 'vp9';
    args = ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '28', '-row-mt', '1', '-cpu-used', '4', '-deadline', 'good', '-pix_fmt', 'yuv420p'];
  } else throw new Error('This ffmpeg has no VP9 encoder.');
  const child = spawn(path, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(options.fps), '-c:v', 'png', '-i', '-', ...args, output], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let exit: number | null | undefined;
  const closed = new Promise<void>((resolve) => child.on('close', (code) => {
    exit = code;
    resolve();
  }));
  child.on('error', (e) => { stderr = e.message; });
  child.stdin!.on('error', () => {});
  child.stderr!.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});
  return {
    push: (png) => new Promise((resolve, reject) => {
      if (exit !== undefined) return reject(new Error(`ffmpeg stopped: ${stderr.trim().split('\n').at(-1) ?? exit}`));
      child.stdin!.write(png, (e) => (e ? reject(e) : resolve()));
    }),
    finish: async () => {
      child.stdin!.end();
      await closed;
      try {
        if (exit !== 0) throw new Error(`ffmpeg failed: ${stderr.trim().split('\n').at(-1) ?? exit}`);
        return { bytes: new Uint8Array(await readFile(output)), codec };
      } finally {
        await cleanup();
      }
    },
    abort: () => {
      child.kill('SIGKILL');
      void closed.then(cleanup);
    },
  };
}

/** Runs in the encoder page. Keeps the output in the page until the server asks for it. */
async function openEncoder(config: { format: 'mp4' | 'webm'; width: number; height: number; fps: number }): Promise<string | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const candidates = config.format === 'mp4'
    ? ['avc1.640034', 'avc1.4d0034', 'vp09.00.51.08', 'av01.0.15M.08']
    : ['vp09.00.51.08', 'vp8', 'av01.0.15M.08'];
  const pixels = config.width * config.height;
  const common = { width: config.width, height: config.height, framerate: config.fps, bitrate: Math.round(Math.min(80_000_000, Math.max(1_000_000, pixels * config.fps * 0.15))), latencyMode: 'quality' as const };
  for (const codec of candidates) {
    const options: VideoEncoderConfig = { ...common, codec, ...(codec.startsWith('avc1') ? { avc: { format: 'avc' as const } } : {}) };
    const support = await VideoEncoder.isConfigSupported(options).catch(() => ({ supported: false }));
    if (!support.supported) continue;
    const state = { chunks: [] as { data: string; type: string; timestamp: number; duration: number; description?: string }[], failure: null as string | null };
    const encode = (bytes: ArrayBuffer | Uint8Array) => {
      const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let text = '';
      for (let i = 0; i < view.length; i += 32768) text += String.fromCharCode(...view.subarray(i, i + 32768));
      return btoa(text);
    };
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        const copy = new Uint8Array(chunk.byteLength);
        chunk.copyTo(copy);
        const description = meta?.decoderConfig?.description;
        state.chunks.push({
          data: encode(copy), type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? 0,
          ...(description ? { description: encode(description instanceof ArrayBuffer ? description : new Uint8Array((description as ArrayBufferView).buffer as ArrayBuffer)) } : {}),
        });
      },
      error: (e) => { state.failure = e.message; },
    });
    encoder.configure(options);
    (window as unknown as { __enc: unknown }).__enc = { encoder, state, width: config.width, height: config.height, fps: config.fps };
    return codec;
  }
  return null;
}

async function encodeFrame(png: string, index: number): Promise<void> {
  const { encoder, state, width, height, fps } = (window as unknown as { __enc: { encoder: VideoEncoder; state: { failure: string | null }; width: number; height: number; fps: number } }).__enc;
  if (state.failure) throw new Error(state.failure);
  const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const microseconds = 1_000_000 / fps;
  const frame = new VideoFrame(canvas, { timestamp: Math.round(index * microseconds), duration: Math.round(microseconds) });
  encoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
  frame.close();
  while (encoder.encodeQueueSize > 4) await new Promise((resolve) => setTimeout(resolve, 5));
}

async function closeEncoder(): Promise<void> {
  const { encoder, state } = (window as unknown as { __enc: { encoder: VideoEncoder; state: { failure: string | null } } }).__enc;
  await encoder.flush();
  encoder.close();
  if (state.failure) throw new Error(state.failure);
}

function drainChunks(): { data: string; type: string; timestamp: number; duration: number; description?: string }[] {
  const { state } = (window as unknown as { __enc: { state: { chunks: { data: string; type: string; timestamp: number; duration: number; description?: string }[] } } }).__enc;
  return state.chunks.splice(0, state.chunks.length);
}

export async function webCodecsSink(page: Page, options: { format: 'mp4' | 'webm'; width: number; height: number; fps: number }): Promise<FrameSink> {
  const codec = await page.evaluate(openEncoder, options);
  if (!codec) throw new Error(`This browser has no encoder for ${options.format.toUpperCase()}, and there is no ffmpeg to use instead.`);
  type Chunk = { data: string; type: string; timestamp: number; duration: number; description?: string };
  const collected: Chunk[] = [];
  const drain = async () => {
    collected.push(...await page.evaluate(drainChunks) as Chunk[]);
  };
  return {
    push: async (png, index) => {
      await page.evaluate(encodeFrame, toBase64(png), index);
      await drain();
    },
    finish: async () => {
      await page.evaluate(closeEncoder);
      await drain();
      const key = (c: Chunk) => c.type as 'key' | 'delta';
      const short = codec.startsWith('avc1') ? 'avc' : codec.startsWith('vp09') ? 'vp9' : codec.startsWith('av01') ? 'av1' : 'vp8';
      const description = collected.find((c) => c.description)?.description;
      const meta = description ? { decoderConfig: { codec, description: Buffer.from(description, 'base64') } } : { decoderConfig: { codec } };
      if (options.format === 'mp4') {
        const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
        const target = new ArrayBufferTarget();
        const muxer = new Muxer({ target, fastStart: 'in-memory', video: { codec: short as 'avc' | 'vp9' | 'av1', width: options.width, height: options.height, frameRate: options.fps } });
        for (const chunk of collected) muxer.addVideoChunkRaw(Buffer.from(chunk.data, 'base64'), key(chunk), chunk.timestamp, chunk.duration, meta as never);
        muxer.finalize();
        return { bytes: new Uint8Array(target.buffer), codec: short === 'avc' ? 'h264' : short };
      }
      const { Muxer, ArrayBufferTarget } = await import('webm-muxer');
      const target = new ArrayBufferTarget();
      const muxer = new Muxer({ target, video: { codec: short === 'vp9' ? 'V_VP9' : short === 'av1' ? 'V_AV1' : 'V_VP8', width: options.width, height: options.height, frameRate: options.fps } });
      for (const chunk of collected) muxer.addVideoChunkRaw(Buffer.from(chunk.data, 'base64'), key(chunk), chunk.timestamp, meta as never);
      muxer.finalize();
      return { bytes: new Uint8Array(target.buffer), codec: short };
    },
    abort: () => {},
  };
}

export async function exportVideo(doc: BogenDoc, renderer: Renderer, target: Target, options: VideoOptions): Promise<VideoResult> {
  const fps = Math.round(Math.max(1, Math.min(60, options.fps ?? 30)));
  const duration = Math.max(1 / fps, Math.min(MAX_VIDEO_SECONDS, options.duration ?? 3));
  const frames = Math.max(1, Math.round(duration * fps));
  const ffmpeg = options.encoder === 'webcodecs' ? null : findFfmpeg();
  if (options.encoder === 'ffmpeg' && !ffmpeg) throw new Error('There is no ffmpeg on this machine. Leave the encoder out to use the browser.');
  const encoderName = ffmpeg ? 'ffmpeg' as const : 'webcodecs' as const;
  return renderer.withLivePage(doc, target, async (page, browser, rect) => {
    const counts = await page.evaluate(installSeek);
    const notDeterministic: string[] = [];
    if (counts.gifs) notDeterministic.push(`${counts.gifs} GIF images run on their own clock`);
    if (counts.embeds) notDeterministic.push(`${counts.embeds} embeds run on their own clock`);
    const size = evenSize(rect, options.scale ?? 1);
    const clip = { x: rect.x, y: rect.y, width: size.width / size.scale, height: size.height / size.scale };
    await page.setViewport({ width: Math.max(1440, Math.ceil(rect.x + clip.width)), height: Math.max(900, Math.ceil(rect.y + clip.height)), deviceScaleFactor: size.scale });

    const run = async (sink: FrameSink): Promise<{ bytes: Uint8Array; codec: string }> => {
      try {
        for (let i = 0; i < frames; i++) {
          await page.evaluate((ms: number) => (window as unknown as { __bogenSeek: (m: number) => Promise<void> }).__bogenSeek(ms), (i * 1000) / fps);
          const png = await page.screenshot({ type: 'png', clip, captureBeyondViewport: false, optimizeForSpeed: true });
          await sink.push(new Uint8Array(png), i);
          options.onFrame?.(i + 1, frames);
        }
        return await sink.finish();
      } catch (e) {
        sink.abort();
        throw e;
      }
    };
    const out = ffmpeg
      ? await run(await ffmpegSink(ffmpeg, { format: options.format, fps }))
      : await withEncoderPage(browser, async (encoderPage) => {
        const sink = await webCodecsSink(encoderPage, { format: options.format, width: size.width, height: size.height, fps });
        await page.bringToFront();
        return run(sink);
      });
    return {
      bytes: out.bytes, codec: out.codec, encoder: encoderName, frames, fps, width: size.width, height: size.height, notDeterministic,
      mime: options.format === 'mp4' ? 'video/mp4' : 'video/webm', ext: options.format,
    };
  });
}
