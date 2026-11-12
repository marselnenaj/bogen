import { api } from '../lib/api.ts';
import { t } from '../i18n/store.ts';

/**
 * Photos from the phone: taken with the camera or picked from the library, made small enough to travel and to
 * show an agent, then stored on the computer as an asset. A JPEG or an iPhone's HEIC is drawn again as a JPEG,
 * which also leaves its metadata behind, the place it was taken among it. A PNG, WebP or GIF that is already
 * small enough goes as it is, transparency and all.
 */

/** The long side of a photo after it is scaled down. Plenty for a layout, and what agents take well. */
export const PHOTO_MAX_SIDE = 2048;
/** What the phone is willing to read at all. A 48 MP ProRAW is past this; a normal photo is far under. */
export const PHOTO_INPUT_LIMIT = 40 * 1024 * 1024;
/** What may go to the computer. The computer takes up to 8 MB per image for an agent. */
export const PHOTO_OUTPUT_LIMIT = 6 * 1024 * 1024;
const JPEG_QUALITY = 0.85;
const KEEP_AS_IS = new Set(['image/png', 'image/webp', 'image/gif']);

export interface Photo { src: string; url: string; width: number; height: number; bytes: number; type: string; reencoded: boolean }

/** The size that fits within `max` on its long side, never larger than it was. */
export function fitWithin(width: number, height: number, max = PHOTO_MAX_SIDE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max || long <= 0) return { width: Math.round(width), height: Math.round(height) };
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Whether a picked file can go as it is, or is drawn again. Pure, for tests. */
export function keepsOriginal(type: string, bytes: number, width: number, height: number): boolean {
  return KEEP_AS_IS.has(type) && bytes <= PHOTO_OUTPUT_LIMIT && Math.max(width, height) <= PHOTO_MAX_SIDE;
}

async function decode(file: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if ('createImageBitmap' in window) {
    try {
      // `from-image` turns a photo the way the camera held it.
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch {
      // Safari decodes HEIC in an <img> more reliably than in createImageBitmap.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    throw new Error(t('This file is not a picture the phone can read.'));
  }
}

/** Reads a picked file and stores it on the computer. Throws with a sentence a person can read. */
export async function sendPhoto(file: File): Promise<Photo> {
  if (!file.type.startsWith('image/') && !/\.(heic|heif|jpe?g|png|webp|gif)$/i.test(file.name)) throw new Error(t('That is not a picture.'));
  if (file.size > PHOTO_INPUT_LIMIT) throw new Error(t('That picture is {size} MB. Pick one under {limit} MB.', { size: Math.round(file.size / 1048576), limit: PHOTO_INPUT_LIMIT / 1048576 }));
  const image = await decode(file);
  try {
    let blob: Blob = file;
    let type = file.type;
    let size = { width: image.width, height: image.height };
    const keep = keepsOriginal(file.type, file.size, image.width, image.height);
    if (!keep) {
      size = fitWithin(image.width, image.height);
      const canvas = document.createElement('canvas');
      canvas.width = size.width;
      canvas.height = size.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error(t('The phone could not draw the picture.'));
      ctx.drawImage(image.source, 0, 0, size.width, size.height);
      type = 'image/jpeg';
      blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t('The phone could not make a JPEG.')))), type, JPEG_QUALITY));
    }
    if (blob.size > PHOTO_OUTPUT_LIMIT) throw new Error(t('That picture is still too large after scaling it down.'));
    const stored = await api.upload(blob, type);
    return { src: stored.src, url: stored.url, width: size.width, height: size.height, bytes: blob.size, type, reencoded: !keep };
  } finally {
    image.close();
  }
}

/** "2048 × 1536, 640 KB" */
export function photoWords(p: Pick<Photo, 'width' | 'height' | 'bytes'>): string {
  const kb = p.bytes / 1024;
  return `${p.width} × ${p.height}, ${kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(kb))} KB`}`;
}

/**
 * Opens the camera or the photo library. On an iPhone, `camera` goes straight to the camera; without it iOS
 * offers the library, the camera and files. The input stays in the page until it is used, which iOS needs.
 */
export function pickPhoto(camera: boolean, onPicked: (file: File) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (camera) input.setAttribute('capture', 'environment');
  input.style.display = 'none';
  input.dataset.testid = camera ? 'photo-input-camera' : 'photo-input-library';
  const done = () => input.remove();
  input.onchange = () => {
    const file = input.files?.[0];
    done();
    if (file) onPicked(file);
  };
  input.addEventListener('cancel', done);
  document.body.appendChild(input);
  input.click();
}
