import { z } from 'zod';
import { driftOfFile } from '../drift.ts';
import { RESTYLE_NOTICE, restyleSite } from '../restyle.ts';
import { fileIdArg, pageIdArg, type ToolDefiner } from './kit.ts';

export function registerDriftTools(define: ToolDefiner): void {
  define('drift_check', { description: 'Compare an artboard with the live page it stands for, to see where the site and the design went apart. Opens the page at the artboard\'s width and colour scheme, compares the pixels and returns a picture with differences in red, and matches layers to live elements by their words, role and place. Returns drifts, each with the layer id, the live element\'s CSS selector and the CSS value on both sides: spacing and sizes, colours and fonts (and whether they are in the brand), changed words, layers missing from the page, and elements only the page has. The address defaults to the one the artboard was captured from. To fix a repository from it, call code_get on the layer of each drift and change the element its selector names. Public pages only; the person can compare with a page on this computer from the editor.', readOnly: true }, {
    node_id: z.string().describe('The artboard, or a layer in it.'),
    url: z.string().url().optional().describe('The live page. Default: where the artboard was captured from.'),
    width: z.number().int().min(200).max(4000).optional().describe('Default: the artboard\'s width.'),
    color_scheme: z.enum(['light', 'dark']).optional().describe('Default: the scheme it was captured in.'),
    limit: z.number().int().min(1).max(500).default(100).describe('At most this many drifts, from the top of the page down.'),
    file_id: fileIdArg,
  }, async ({ node_id, url, width, color_scheme, limit, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { report, picture } = await driftOfFile(ctx.app, room.id, { nodeId: node_id, ...(url ? { url } : {}), ...(width ? { width } : {}), ...(color_scheme ? { colorScheme: color_scheme } : {}), allowLocal: false, limit });
    ctx.touch([report.node_id]);
    const { at: _at, ...rest } = report;
    return {
      content: [
        { type: 'text', text: JSON.stringify({ ...rest, next: report.drifts.length ? 'For each drift, decide with the person which side is right. To change the repository, code_get the layer and edit the element named by live_element.selector. To change the design, use layer_style or layer_text on layer_id.' : 'The design and the page agree.' }, null, 1) },
        { type: 'image', data: Buffer.from(picture).toString('base64'), mimeType: 'image/png' },
      ],
    };
  });

  define('site_restyle', { description: `"Like this site, but in our brand": capture a public page and redraw its layout in a brand, on a new artboard. Its colours go onto the brand's palette by lightness and by what they do (text, surface, border, accent), its fonts onto the brand's families, its font sizes, spacing and radii onto the brand's scales, through the same replacement brand_apply uses. Text and images become placeholders unless keep_text or keep_images is true. Then it runs brand_check on the result and reports it. A file that follows another brand is left alone and the artboard goes into a new file. ${RESTYLE_NOTICE} Tell the person so. Only when they asked for it.` }, {
    url: z.string().url(),
    brand_id: z.string().optional().describe('Default: the brand the file follows, then the default brand.'),
    keep_text: z.boolean().default(false).describe('Keep the page\'s words instead of placeholders. Only if the person has the right to use them.'),
    keep_images: z.boolean().default(false).describe('Keep the page\'s images and vectors instead of placeholders. Only if the person has the right to use them.'),
    width: z.number().int().min(200).max(4000).default(1440),
    color_scheme: z.enum(['light', 'dark']).optional(),
    name: z.string().min(1).max(200).optional(),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ url, brand_id, keep_text, keep_images, width, color_scheme, name, page_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const result = await restyleSite(ctx.app, {
      url, fileId: room.id, ...(brand_id ? { brandId: brand_id } : {}), ...(page_id && room.doc.pages.has(page_id) ? { pageId: page_id } : {}),
      keepText: keep_text, keepImages: keep_images, width, ...(color_scheme ? { colorScheme: color_scheme } : {}), ...(name ? { name } : {}),
      allowLocal: false, actor: ctx.agent,
    });
    ctx.wrote = true;
    ctx.touch([result.node_id]);
    return { ...result, next: 'Look at it with canvas_screenshot, then fix what brand_check found. Replace the placeholders with the person\'s own words and images.' };
  });
}
