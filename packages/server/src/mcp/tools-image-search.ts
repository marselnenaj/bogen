import { z } from 'zod';
import { usedAssets } from '../bogen-file.ts';
import { creditsText, readImageCredits } from '../image-credits.ts';
import { IMAGE_PROVIDERS, searchImages } from '../image-search.ts';
import { fileIdArg, type ToolDefiner } from './kit.ts';

/** Free photos with their licence, and the credits a file owes for the ones it uses. */
export function registerImageSearchTools(define: ToolDefiner): void {
  define('image_search', {
    description: 'Search free photos and pictures to use in a design: Openverse (Flickr, Wikimedia, museums and more) and Wikimedia Commons. Only CC0, public domain, CC BY and CC BY-SA come back, each with author, licence, source page, size and a credit line; NC and ND licences are left out. Look at thumbnails, then import one with asset_upload from_search, which stores the image and keeps its credit with the file (image_credits lists them). CC BY and CC BY-SA need the credit shown where the design is published. For an image that does not exist yet, use image_generate when the person has the Codex CLI, or your own image tool, then asset_upload with path.',
    readOnly: true,
  }, {
    query: z.string().min(2).max(200).describe('What the picture shows, in English for the most results: "pea pod in hand", "community garden raised beds".'),
    provider: z.enum([...IMAGE_PROVIDERS, 'both']).default('both'),
    orientation: z.enum(['any', 'landscape', 'portrait', 'square']).default('any'),
    limit: z.number().int().min(1).max(40).default(12),
  }, async ({ query, provider, orientation, limit }) => {
    const { results, skipped, errors } = await searchImages(query, { provider, orientation, limit });
    if (!results.length && errors.length) throw new Error(`The search failed: ${errors.join('; ')}`);
    return {
      results: results.map((r) => ({ id: r.id, title: r.title, author: r.author, license: r.licenseName, size: r.width && r.height ? `${r.width}x${r.height}` : undefined, thumbnail: r.thumbnail, source: r.source, ...(r.via ? { via: r.via } : {}) })),
      ...(skipped ? { left_out: `${skipped} without a free licence or without a usable image` } : {}),
      ...(errors.length ? { errors } : {}),
      next: results.length ? 'asset_upload with from_search set to an id imports it with its credit.' : 'Nothing free matched: try other words, or provider both.',
    };
  });

  define('image_credits', {
    description: 'The credits this file owes: every image it uses that came from image_search, with author, licence and source, and a block of text to put in a footer, a closing slide or a README. CC BY and CC BY-SA require it where the design is published.',
    readOnly: true,
  }, { file_id: fileIdArg }, async ({ file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const used = new Set(usedAssets(room.doc));
    const credits = readImageCredits(room.doc, used);
    const owed = credits.filter((c) => c.license === 'CC BY' || c.license === 'CC BY-SA').length;
    return {
      credits: credits.map((c) => ({ asset: `bogen-asset:${c.asset}`, title: c.title, author: c.author, license: c.licenseName, source: c.source, credit: c.credit })),
      text: creditsText(credits) || null,
      ...(owed ? { required: `${owed} of these need the credit shown with the design.` } : {}),
      ...(credits.length ? {} : { note: 'No image in this file came from image_search. Images you made or uploaded carry no recorded licence.' }),
    };
  });
}
