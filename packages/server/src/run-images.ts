import type { RunImage } from './agents.ts';
import { Storage } from './storage.ts';
import { HttpError } from './util.ts';

/** What a run can be shown: the image types both CLIs read. */
const RUN_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
/** Per image. The phone scales photos down to 2048 px before they leave it, which is far under this. */
export const RUN_IMAGE_LIMIT = 8 * 1024 * 1024;
export const RUN_IMAGES_MAX = 4;

/** `bogen-asset:<hash>.jpg` or the bare name, as the name in the asset folder. */
export function assetNameOf(src: string): string | null {
  const name = src.startsWith('bogen-asset:') ? src.slice('bogen-asset:'.length) : src;
  return Storage.isAssetName(name) ? name : null;
}

/**
 * Stored images, as images that go with a run's request: a photo from the phone attached to an Ask or to a
 * comment that mentions an agent. Only image types the CLIs read, and none over the limit.
 */
export async function runImages(storage: Pick<Storage, 'readAsset'>, sources: string[]): Promise<RunImage[]> {
  const out: RunImage[] = [];
  for (const src of sources.slice(0, RUN_IMAGES_MAX)) {
    const name = assetNameOf(src);
    if (!name) throw new HttpError(400, `"${src}" is not an image of this file.`);
    const asset = await storage.readAsset(name);
    if (!asset) throw new HttpError(404, `The image ${name} is not on this computer.`);
    if (!RUN_IMAGE_TYPES.has(asset.mime)) throw new HttpError(415, `An agent can be shown PNG, JPEG, WebP or GIF, not ${asset.mime}.`);
    if (asset.bytes.byteLength > RUN_IMAGE_LIMIT) throw new HttpError(413, `The image ${name} is larger than ${RUN_IMAGE_LIMIT / 1048576} MB.`);
    out.push({ data: Buffer.from(asset.bytes), mime: asset.mime, name });
  }
  return out;
}
