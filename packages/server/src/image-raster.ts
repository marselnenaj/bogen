import { inflateSync } from 'node:zlib';

/**
 * Small raster helpers that need no browser: the pixel size of an image from its header, and PNG decoding to
 * RGBA for vectorizing. Other formats decode in the renderer's Chromium (vectorize.ts).
 */
export interface Rgba { width: number; height: number; data: Uint8ClampedArray }

/** Width and height from the file header of a PNG, JPEG, GIF or WebP, or null. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > 24 && b.toString('hex', 0, 8) === '89504e470d0a1a0a') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString('latin1', 0, 4) === 'GIF8') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    // The first start-of-frame marker holds the size; every other segment says its own length.
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + length;
    }
  }
  return null;
}

const MAX_DECODE_PIXELS = 40_000_000;

/** Decodes a non-interlaced PNG of any colour type and bit depth to 8-bit RGBA. Throws for what it cannot read. */
export function decodePng(bytes: Uint8Array): Rgba {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 33 || b.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('That is not a PNG.');
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  let palette: Buffer | undefined;
  let alphas: Buffer | undefined;
  const idat: Buffer[] = [];
  for (let i = 8; i + 8 <= b.length;) {
    const length = b.readUInt32BE(i);
    const kind = b.toString('latin1', i + 4, i + 8);
    const data = b.subarray(i + 8, i + 8 + length);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8]!;
      type = data[9]!;
      interlace = data[12]!;
    } else if (kind === 'PLTE') palette = data;
    else if (kind === 'tRNS') alphas = data;
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    i += 12 + length;
  }
  if (!width || !height || width * height > MAX_DECODE_PIXELS) throw new Error('This PNG has no size, or is too large to decode.');
  if (interlace) throw new Error('Interlaced PNG.');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('This PNG has an unknown colour type.');
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  if (raw.length < (stride + 1) * height) throw new Error('This PNG is cut short.');
  const out = new Uint8ClampedArray(width * height * 4);
  let prev = Buffer.alloc(stride);
  const max = (1 << depth) - 1;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? line[x - bpp]! : 0;
      const up = prev[x]!;
      const corner = x >= bpp ? prev[x - bpp]! : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      }
      line[x] = (line[x]! + add) & 0xff;
    }
    prev = line;
    // One sample by index, scaled to 8 bits.
    const sample = (index: number): number => {
      if (depth === 8) return line[index]!;
      if (depth === 16) return line[index * 2]!;
      const bit = index * depth;
      return (line[bit >> 3]! >> (8 - depth - (bit & 7))) & max;
    };
    const to8 = (v: number) => (depth >= 8 ? v : Math.round((v * 255) / max));
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 3) {
        const index = sample(x);
        out[o] = palette?.[index * 3] ?? 0;
        out[o + 1] = palette?.[index * 3 + 1] ?? 0;
        out[o + 2] = palette?.[index * 3 + 2] ?? 0;
        out[o + 3] = alphas && index < alphas.length ? alphas[index]! : 255;
      } else if (type === 0 || type === 4) {
        const g = to8(sample(x * channels));
        out[o] = out[o + 1] = out[o + 2] = g;
        out[o + 3] = type === 4 ? to8(sample(x * channels + 1)) : 255;
      } else {
        out[o] = sample(x * channels);
        out[o + 1] = sample(x * channels + 1);
        out[o + 2] = sample(x * channels + 2);
        out[o + 3] = type === 6 ? sample(x * channels + 3) : 255;
      }
    }
  }
  return { width, height, data: out };
}

/** Box-filtered down to at most `maxPixels`, keeping the ratio. The tracer's time grows with the pixel count. */
export function downscale(img: Rgba, maxPixels: number): Rgba {
  const ratio = Math.sqrt(maxPixels / (img.width * img.height));
  if (ratio >= 1) return img;
  const width = Math.max(1, Math.floor(img.width * ratio));
  const height = Math.max(1, Math.floor(img.height * ratio));
  const out = new Uint8ClampedArray(width * height * 4);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, bl = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          r += img.data[i]!; g += img.data[i + 1]!; bl += img.data[i + 2]!; a += img.data[i + 3]!; n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = bl / n; out[o + 3] = a / n;
    }
  }
  return { width, height, data: out };
}
