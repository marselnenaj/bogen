import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser } from 'puppeteer-core';
import { ffmpegEncoders, findFfmpeg, runFfmpeg, toBase64, withEncoderPage } from './media.ts';

/**
 * AVIF: an AV1 key frame in an image container. Encoded with WebCodecs in the browser when it has an
 * AV1 encoder, otherwise with ffmpeg. Keeping transparency takes ffmpeg, since a second plane for alpha
 * is more than WebCodecs offers.
 */
export interface AvifResult { bytes: Uint8Array; encoder: 'webcodecs' | 'ffmpeg'; alpha: boolean }

function box(type: string, ...parts: (Buffer | Uint8Array)[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}

function fullBox(type: string, version: number, flags: number, ...parts: (Buffer | Uint8Array)[]): Buffer {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(((version & 0xff) << 24) | (flags & 0xffffff), 0);
  return box(type, head, ...parts);
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

interface Obu { type: number; start: number; end: number; payload: number }

/** Low-overhead OBUs, which is what encoders hand out. */
function readObus(data: Uint8Array): Obu[] {
  const out: Obu[] = [];
  let at = 0;
  while (at < data.length) {
    const start = at;
    const header = data[at++]!;
    const type = (header >> 3) & 0xf;
    if (header & 0x4) at++;
    let size = 0;
    if (header & 0x2) {
      for (let i = 0; i < 8; i++) {
        const byte = data[at++]!;
        size |= (byte & 0x7f) * 2 ** (7 * i);
        if (!(byte & 0x80)) break;
      }
    } else size = data.length - at;
    out.push({ type, start, payload: at, end: at + size });
    at += size;
  }
  return out;
}

/** The fields av1C repeats from the sequence header. Encoders use the plain form, where they are near the top. */
function readSequenceHeader(data: Uint8Array): { profile: number; level: number; tier: number } {
  let bit = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | (((data[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
    return v;
  };
  const profile = read(3);
  read(1);
  const reduced = read(1);
  if (reduced) return { profile, level: read(5), tier: 0 };
  if (read(1)) return { profile, level: 8, tier: 0 };
  if (read(1)) return { profile, level: 8, tier: 0 };
  read(5);
  read(12);
  const level = read(5);
  return { profile, level, tier: level > 7 ? read(1) : 0 };
}

/** An AVIF file around one AV1 key frame in 8-bit 4:2:0, the output WebCodecs gives. */
export function wrapAvif(frame: Uint8Array, width: number, height: number): Buffer {
  const obus = readObus(frame);
  const sequence = obus.find((o) => o.type === 1);
  if (!sequence) throw new Error('The encoder returned no sequence header.');
  const { profile, level, tier } = readSequenceHeader(frame.subarray(sequence.payload, sequence.end));
  const configObu = frame.subarray(sequence.start, sequence.end);
  // The temporal delimiter has no place in an image item.
  const item = Buffer.concat(obus.filter((o) => o.type !== 2).map((o) => frame.subarray(o.start, o.end)));
  const av1C = box('av1C', Buffer.from([0x81, (profile << 5) | level, (tier << 7) | (1 << 3) | (1 << 2), 0]), configObu);
  const ispe = fullBox('ispe', 0, 0, u32(width), u32(height));
  const pixi = fullBox('pixi', 0, 0, Buffer.from([3, 8, 8, 8]));
  const colr = box('colr', Buffer.from('nclx', 'latin1'), u16(1), u16(13), u16(1), Buffer.from([0x00]));
  const iprp = box('iprp',
    box('ipco', av1C, ispe, pixi, colr),
    fullBox('ipma', 0, 0, u32(1), u16(1), Buffer.from([4, 0x81, 2, 3, 4])),
  );
  const hdlr = fullBox('hdlr', 0, 0, u32(0), Buffer.from('pict', 'latin1'), Buffer.alloc(12), Buffer.from('\0', 'latin1'));
  const pitm = fullBox('pitm', 0, 0, u16(1));
  const infe = fullBox('infe', 2, 0, u16(1), u16(0), Buffer.from('av01', 'latin1'), Buffer.from('\0', 'latin1'));
  const iinf = fullBox('iinf', 0, 0, u16(1), infe);
  const ftyp = box('ftyp', Buffer.from('avif', 'latin1'), u32(0), Buffer.from('avifmif1miafMA1B', 'latin1'));
  const metaWith = (offset: number) => fullBox('meta', 0, 0, hdlr, pitm,
    fullBox('iloc', 0, 0, Buffer.from([0x44, 0x00]), u16(1), u16(1), u16(0), u16(1), u32(offset), u32(item.length)),
    iinf, iprp);
  const size = ftyp.length + metaWith(0).length + 8;
  return Buffer.concat([ftyp, metaWith(size), box('mdat', item)]);
}

/** Runs in the encoder page. Returns the one chunk as base64, or null when there is no such encoder. */
async function encodeInPage(png: string, quality: number): Promise<{ data: string; width: number; height: number } | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  const { width, height } = bitmap;
  const config = { codec: 'av01.0.15M.08', width: width + (width % 2), height: height + (height % 2), latencyMode: 'quality', bitrate: Math.round(width * height * (0.5 + quality * 8)) } as VideoEncoderConfig;
  const support = await VideoEncoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) return null;
  const canvas = new OffscreenCanvas(config.width, config.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, config.width, config.height);
  ctx.drawImage(bitmap, 0, 0);
  const chunks: Uint8Array[] = [];
  let failure: string | null = null;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      const copy = new Uint8Array(chunk.byteLength);
      chunk.copyTo(copy);
      chunks.push(copy);
    },
    error: (e) => { failure = e.message; },
  });
  encoder.configure(config);
  const frame = new VideoFrame(canvas, { timestamp: 0 });
  encoder.encode(frame, { keyFrame: true });
  frame.close();
  await encoder.flush();
  encoder.close();
  if (failure || !chunks.length) return null;
  let text = '';
  for (const byte of chunks[0]!) text += String.fromCharCode(byte);
  return { data: btoa(text), width: config.width, height: config.height };
}

async function viaFfmpeg(path: string, png: Uint8Array, quality: number, alpha: boolean): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'bogen-avif-'));
  try {
    const input = join(dir, 'in.png');
    const output = join(dir, 'out.avif');
    await writeFile(input, png);
    const encoders = ffmpegEncoders(path);
    const codec = encoders.has('libaom-av1') ? ['-c:v', 'libaom-av1', '-cpu-used', '6', '-still-picture', '1', '-crf', String(Math.round(40 - quality * 25))] : encoders.has('libsvtav1') ? ['-c:v', 'libsvtav1', '-crf', String(Math.round(40 - quality * 25))] : null;
    if (!codec) throw new Error('This ffmpeg has no AV1 encoder.');
    const mapping = alpha
      ? ['-filter_complex', '[0:v]format=yuva420p,split[c][a];[a]alphaextract[m]', '-map', '[c]', '-map', '[m]']
      : ['-pix_fmt', 'yuv420p'];
    await runFfmpeg(path, ['-y', '-i', input, ...mapping, ...codec, '-frames:v', '1', '-f', 'avif', output]);
    return new Uint8Array(await readFile(output));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function encodeAvif(browser: Browser, png: Uint8Array, options: { quality?: number; alpha?: boolean } = {}): Promise<AvifResult> {
  const quality = Math.max(0, Math.min(1, options.quality ?? 0.8));
  const ffmpeg = findFfmpeg();
  if (options.alpha && ffmpeg) return { bytes: await viaFfmpeg(ffmpeg, png, quality, true), encoder: 'ffmpeg', alpha: true };
  const encoded = await withEncoderPage(browser, (page) => page.evaluate(encodeInPage, toBase64(png), quality));
  if (encoded) return { bytes: new Uint8Array(wrapAvif(Buffer.from(encoded.data, 'base64'), encoded.width, encoded.height)), encoder: 'webcodecs', alpha: false };
  if (ffmpeg) return { bytes: await viaFfmpeg(ffmpeg, png, quality, false), encoder: 'ffmpeg', alpha: false };
  throw new Error('AVIF needs an AV1 encoder, and neither this browser nor an ffmpeg on the PATH has one.');
}
