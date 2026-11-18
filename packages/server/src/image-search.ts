import { fetchPublic } from './net-guard.ts';

/**
 * Free images with a licence that allows use in a design: Openverse (which indexes Flickr, Wikimedia, museums and
 * more) and Wikimedia Commons. Only CC0, public domain, CC BY and CC BY-SA come back, each with its author, licence
 * and source page, so the design can credit it. Importing a result asks the provider again by its id: the licence
 * that is stored comes from the provider, never from what an agent passes on.
 */

export const IMAGE_PROVIDERS = ['openverse', 'commons'] as const;
export type ImageProvider = (typeof IMAGE_PROVIDERS)[number];

/** The licences that let a person use an image in their design, credited where the licence asks for it. */
export type FreeLicense = 'CC0' | 'Public domain' | 'CC BY' | 'CC BY-SA';

export interface ImageResult {
  /** provider:id, for asset_upload from_search. */
  id: string;
  title: string;
  author: string;
  license: FreeLicense;
  /** As the provider writes it, with its version, such as "CC BY-SA 4.0". */
  licenseName: string;
  licenseUrl: string;
  /** The page that shows the image and its terms. */
  source: string;
  /** A small picture to look at. */
  thumbnail: string;
  /** The image itself, at its full size or a large rendition. */
  url: string;
  width: number;
  height: number;
  provider: ImageProvider;
  /** Who indexed it, for Openverse: flickr, wikimedia, a museum. */
  via?: string;
  /** The line to put in the design's credits. */
  credit: string;
}

export const IMAGE_HOSTS: Record<ImageProvider, string> = { openverse: 'api.openverse.org', commons: 'commons.wikimedia.org' };

type JsonFetch = (url: string) => Promise<unknown>;

const json: JsonFetch = async (url) => {
  const got = await fetchPublic(url, { timeoutMs: 12_000, maxBytes: 4 * 1024 * 1024, headers: { accept: 'application/json', 'user-agent': 'Bogen image_search (https://bogen.dev)' }, accept: (t) => /json/.test(t) });
  return JSON.parse(Buffer.from(got.bytes).toString('utf8'));
};

/** The free licence a provider's code or short name stands for, or null for any other (NC, ND, unknown). */
export function freeLicense(code: string): FreeLicense | null {
  const c = code.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (c === 'cc0' || c.startsWith('cc0-') || c === 'cc-zero') return 'CC0';
  if (c === 'pdm' || c === 'pd' || c.startsWith('public-domain') || c.startsWith('pd-')) return 'Public domain';
  if (c === 'by' || /^cc-by(-\d|$)/.test(c)) return 'CC BY';
  if (c === 'by-sa' || /^cc-by-sa(-\d|$)/.test(c)) return 'CC BY-SA';
  return null;
}

/** Plain text of a provider's HTML field, such as Commons' Artist. */
export function plainText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

export function creditLine(r: Pick<ImageResult, 'title' | 'author' | 'licenseName' | 'license' | 'source'>): string {
  const by = r.author ? ` by ${r.author}` : '';
  return r.license === 'Public domain' || r.license === 'CC0' ? `"${r.title}"${by}, ${r.licenseName}, ${r.source}` : `"${r.title}"${by}, licensed under ${r.licenseName}, ${r.source}`;
}

const clip = (s: unknown, n = 300) => (typeof s === 'string' ? s.slice(0, n) : '');
const httpsUrl = (s: unknown) => (typeof s === 'string' && /^https?:\/\//.test(s) && s.length < 2000 ? s : '');

/** One Openverse result, or null when its licence is not a free one or it lacks what a credit needs. */
export function fromOpenverse(raw: Record<string, unknown>): ImageResult | null {
  const license = freeLicense(String(raw.license ?? ''));
  const url = httpsUrl(raw.url);
  if (!license || !url || typeof raw.id !== 'string') return null;
  const version = clip(raw.license_version, 10);
  const licenseName = license === 'CC0' ? `CC0 ${version || '1.0'}` : license === 'Public domain' ? 'Public Domain Mark' : `${license} ${version}`.trim();
  const r = {
    id: `openverse:${raw.id}`, title: clip(raw.title) || 'Untitled', author: clip(raw.creator), license, licenseName,
    licenseUrl: httpsUrl(raw.license_url), source: httpsUrl(raw.foreign_landing_url) || url, thumbnail: httpsUrl(raw.thumbnail) || url, url,
    width: Number(raw.width) || 0, height: Number(raw.height) || 0, provider: 'openverse' as const, via: clip(raw.source, 60) || undefined,
  };
  return { ...r, credit: creditLine(r) };
}

/** One Commons file page (prop=imageinfo with extmetadata), or null when it is not free or not an image. */
export function fromCommons(page: Record<string, unknown>): ImageResult | null {
  const info = (Array.isArray(page.imageinfo) ? page.imageinfo[0] : undefined) as Record<string, unknown> | undefined;
  if (!info || !/^image\/(png|jpeg|webp|gif)$/.test(String(info.mime ?? ''))) return null;
  const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown }>;
  const short = plainText(String(meta.LicenseShortName?.value ?? ''));
  const license = freeLicense(short) ?? freeLicense(String(meta.License?.value ?? ''));
  const url = httpsUrl(info.url);
  if (!license || !url) return null;
  const title = plainText(String(meta.ObjectName?.value ?? '')) || String(page.title ?? '').replace(/^File:/, '').replace(/\.\w+$/, '');
  const r = {
    id: `commons:${page.pageid}`, title: title.slice(0, 300) || 'Untitled', author: plainText(String(meta.Artist?.value ?? '')).slice(0, 300), license,
    licenseName: short || license, licenseUrl: httpsUrl(meta.LicenseUrl?.value), source: httpsUrl(info.descriptionurl) || url,
    thumbnail: httpsUrl(info.thumburl) || url, url: httpsUrl(info.thumburl) && Number(info.width) > 3000 ? httpsUrl(info.thumburl) : url,
    width: Number(info.width) || 0, height: Number(info.height) || 0, provider: 'commons' as const,
  };
  return { ...r, credit: creditLine(r) };
}

const OPENVERSE = 'https://api.openverse.org/v1/images/';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const COMMONS_PROPS = 'prop=imageinfo&iiprop=url|size|mime|extmetadata&iiextmetadatafilter=LicenseShortName|License|LicenseUrl|Artist|ObjectName&iiurlwidth=2400&format=json&origin=*';

export interface SearchOptions { provider?: ImageProvider | 'both'; limit?: number; orientation?: 'any' | 'landscape' | 'portrait' | 'square' }

export async function searchImages(query: string, options: SearchOptions = {}, fetchJson: JsonFetch = json): Promise<{ results: ImageResult[]; skipped: number; errors: string[] }> {
  const limit = Math.max(1, Math.min(40, options.limit ?? 12));
  const which: ImageProvider[] = options.provider === 'both' || !options.provider ? ['openverse', 'commons'] : [options.provider];
  const errors: string[] = [];
  let skipped = 0;
  const lists = await Promise.all(which.map(async (p) => {
    try {
      if (p === 'openverse') {
        const ar = options.orientation && options.orientation !== 'any' ? `&aspect_ratio=${options.orientation === 'landscape' ? 'wide' : options.orientation === 'portrait' ? 'tall' : 'square'}` : '';
        const data = (await fetchJson(`${OPENVERSE}?q=${encodeURIComponent(query)}&license=cc0,pdm,by,by-sa&page_size=${limit}${ar}&mature=false`)) as { results?: Record<string, unknown>[] };
        const all = data.results ?? [];
        const ok = all.map(fromOpenverse).filter((r): r is ImageResult => r !== null);
        skipped += all.length - ok.length;
        return ok;
      }
      const data = (await fetchJson(`${COMMONS}?action=query&generator=search&gsrsearch=${encodeURIComponent(`filetype:bitmap ${query}`)}&gsrnamespace=6&gsrlimit=${limit}&${COMMONS_PROPS}`)) as { query?: { pages?: Record<string, Record<string, unknown>> } };
      const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
      const ok = pages.map(fromCommons).filter((r): r is ImageResult => r !== null);
      skipped += pages.length - ok.length;
      return ok;
    } catch (e) {
      errors.push(`${IMAGE_HOSTS[p]}: ${(e as Error).message}`);
      return [];
    }
  }));
  const shape = (r: ImageResult) => {
    if (!options.orientation || options.orientation === 'any' || !r.width || !r.height) return true;
    const ratio = r.width / r.height;
    return options.orientation === 'landscape' ? ratio > 1.1 : options.orientation === 'portrait' ? ratio < 0.9 : ratio >= 0.9 && ratio <= 1.1;
  };
  // Interleaved, so both providers show when both are asked.
  const results: ImageResult[] = [];
  for (let i = 0; results.length < limit && lists.some((l) => i < l.length); i++) for (const l of lists) if (l[i] && shape(l[i]!) && results.length < limit) results.push(l[i]!);
  return { results, skipped, errors };
}

/** One result again, from the provider, by the id search gave. */
export async function imageById(id: string, fetchJson: JsonFetch = json): Promise<ImageResult> {
  const m = /^(openverse|commons):([\w-]{1,80})$/.exec(id.trim());
  if (!m) throw new Error(`"${id}" is not an id from image_search, such as openverse:4b2c... or commons:12345.`);
  if (m[1] === 'openverse') {
    const raw = (await fetchJson(`${OPENVERSE}${encodeURIComponent(m[2]!)}/`)) as Record<string, unknown>;
    const r = fromOpenverse(raw);
    if (!r) throw new Error('Openverse no longer lists this image under a free licence.');
    return r;
  }
  if (!/^\d+$/.test(m[2]!)) throw new Error('A Commons id is a number.');
  const data = (await fetchJson(`${COMMONS}?action=query&pageids=${m[2]}&${COMMONS_PROPS}`)) as { query?: { pages?: Record<string, Record<string, unknown>> } };
  const page = Object.values(data.query?.pages ?? {})[0];
  const r = page ? fromCommons(page) : null;
  if (!r) throw new Error('Commons does not list this file as an image under a free licence.');
  return r;
}
