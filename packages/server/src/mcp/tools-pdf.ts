import { z } from 'zod';
import { readLocalImage } from '../images.ts';
import { importPdf, importSummary, MAX_IMPORT_BYTES, sniffLayerFile } from '../layer-import.ts';
import { MAX_PDF_PAGES } from '../pdf-import.ts';
import { fileIdArg, outline, pageIdArg, type ToolDefiner } from './kit.ts';
import { placeLayers } from './tools-diagram.ts';

const LOOPBACK = new Set([undefined, '127.0.0.1', 'localhost', '::1']);
const MAX_BASE64 = 8 * 1024 * 1024;

export function registerPdfTools(define: ToolDefiner): void {
  define('pdf_import', { description: `Bring the pages of a PDF onto the canvas as editable layers, one board per page at its size (1pt is 4/3 px, so 12pt text is 16px). Text comes in as text layers with its font (substituted by name: the PDF's own fonts are not installed), size, weight and colour; lines, shapes and fills as SVG vector layers; images as pictures from their own pixels. What has no plain form (gradients and patterns, soft masks and blend modes, image masks, Type 3 fonts, form fields and annotations) is drawn alone by pdf.js and placed as a picture where it was, and report says per page which parts those were and why. Nothing in the PDF runs: no scripts, no forms, no fonts loaded. Up to ${MAX_PDF_PAGES} pages per call and ${MAX_IMPORT_BYTES / 1024 / 1024} MB. Then canvas_screenshot a page.` }, {
    path: z.string().min(1).max(4096).optional().describe('A PDF on this computer, as an absolute path (~/ works), under the home or temp folder.'),
    data_base64: z.string().min(1).optional().describe(`Or the file as base64, up to ${MAX_BASE64 / 1024 / 1024} MB.`),
    pages: z.array(z.number().int().min(1).max(10000)).max(MAX_PDF_PAGES).optional().describe('Which pages, from 1. Default all, up to the limit.'),
    name: z.string().min(1).max(120).optional().describe('The boards\' name. Default the PDF\'s title, with the page number.'),
    x: z.number().optional().describe('Where the first board goes on the page. Default the next free spot.'),
    y: z.number().optional(),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ path, data_base64, pages, name, x, y, page_id, file_id }, ctx) => {
    if (Boolean(path) === Boolean(data_base64)) throw new Error('Give either path or data_base64.');
    let bytes: Buffer;
    if (path) {
      if (!LOOPBACK.has(ctx.app.options.host)) throw new Error('path works only on a server that listens on this machine alone. Send the file as data_base64.');
      bytes = await readLocalImage(path, MAX_IMPORT_BYTES);
    } else {
      const raw = data_base64!.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
      if (raw.length > Math.ceil(MAX_BASE64 / 3) * 4) throw new Error(`That is over the limit of ${MAX_BASE64 / 1024 / 1024} MB. Give path instead.`);
      bytes = Buffer.from(raw, 'base64');
    }
    if (sniffLayerFile(bytes) !== 'pdf') throw new Error('That is not a PDF.');
    const room = await ctx.room(file_id);
    const pageId = ctx.page(room, page_id);
    const out = await importPdf(ctx.app.storage, ctx.app.renderer, bytes, { pages, name });
    if (!out.specs.length) throw new Error(`None of the pages asked for are in this PDF, which has ${out.total}.`);
    const ids = ctx.write(room, () => placeLayers(ctx, room.doc, out.specs, { pageId, x, y }));
    ctx.touch(ids);
    return {
      ids, summary: importSummary(out), total_pages: out.total, ...(out.title ? { title: out.title } : {}),
      report: out.pages.map((p, i) => ({ ...p, board: ids[i] })), ...(out.notes.length ? { notes: out.notes } : {}),
      tree: outline(room.doc, ids.slice(0, 2), 2, 30), next: 'canvas_screenshot a board. Fonts are matched by name; set the real family with layer_style where it matters.',
    };
  });
}
