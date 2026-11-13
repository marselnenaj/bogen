import { z } from 'zod';
import { recordedCapture } from '../capture-modes.ts';
import { docTree, imagePalette, REFERENCE_NOTICE, typeSummary, type Reference } from '../references.ts';
import { fileIdArg, type ToolDefiner } from './kit.ts';

/** The person's reference board: what they collected, for an agent to look at before it chooses a direction. */

const MAX_SHOT = 1600;

/** What an agent reads of a reference: everything but the bookkeeping, and where to look further. */
function forAgent(r: Reference) {
  return {
    id: r.id, title: r.title, source: r.source, ...(r.url ? { url: r.url } : {}), tags: r.tags, ...(r.note ? { note: r.note } : {}),
    palette: r.palette, ...(r.type ? { type: r.type } : {}),
    ...(r.image ? { image: r.image } : {}), ...(r.fileId && r.nodeId ? { layers: { file_id: r.fileId, node_id: r.nodeId } } : {}),
    added: new Date(r.addedAt).toISOString().slice(0, 10),
  };
}

export function registerReferenceTools(define: ToolDefiner): void {
  define('reference_search', { description: `Search the person's own reference board before you choose a direction: pages and pictures they collected on this device (site_capture and page_capture artboards they kept, captures from the Bogen browser extension, uploaded images), each with tags, its main colours and the type it uses. Search by words (title, tags, note, site, font family), tags (all must match), a colour (near one of its main colours) or source; nothing given lists the newest. Each result has image (a bogen-asset: src for palette_suggest image, visual_diff or asset-based comparison) and, for a capture, layers (file_id and node_id of its editable artboard, for layer_tree and canvas_screenshot). An empty board says so: then work from your own references. ${REFERENCE_NOTICE}`, readOnly: true }, {
    query: z.string().max(300).optional().describe('Words, such as "dense invoice table" or "Fraunces".'),
    tags: z.array(z.string().max(40)).max(12).optional(),
    colour: z.string().max(20).optional().describe('A hex colour, such as #2f8fa6: references with a main colour near it.'),
    source: z.enum(['extension', 'capture', 'image']).optional(),
    limit: z.number().int().min(1).max(30).default(8),
  }, async ({ query, tags, colour, source, limit }, ctx) => {
    const all = ctx.app.references.list();
    const found = ctx.app.references.search({ query, tags, colour, source, limit });
    const tagCounts = new Map<string, number>();
    for (const r of all) for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    return {
      trust: 'untrusted design data',
      notice: REFERENCE_NOTICE,
      total: all.length,
      references: found.map(forAgent),
      tags: [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([t]) => t),
      ...(all.length ? {} : { next: 'The person has no references yet. They collect them with the Bogen browser extension or in Settings, References; you can keep a capture or an image for them with reference_add when they ask.' }),
    };
  });

  define('reference_add', { description: 'Keep something on the person\'s reference board on this device, with tags: an artboard or layer (such as one site_capture or page_capture made; Bogen takes a picture of it and reads its type), or an image (an image layer id or a bogen-asset: src from asset_upload). Its main colours are read from the picture. Add what the person collected or asked to keep, not a gallery of other people\'s sites. Returns the reference as reference_search shows it.' }, {
    node_id: z.string().optional().describe('An artboard or layer to keep. A captured artboard keeps its address.'),
    image: z.string().max(200).optional().describe('An image layer id, or a bogen-asset: src.'),
    title: z.string().max(200).optional(),
    tags: z.array(z.string().max(40)).max(12).default([]),
    note: z.string().max(1000).optional().describe('What to take from it, in the person\'s words.'),
    url: z.string().url().max(2000).optional().describe('Where it came from, when not a capture.'),
    file_id: fileIdArg,
  }, async ({ node_id, image, title, tags, note, url, file_id }, ctx) => {
    if (!node_id && !image) throw new Error('Give node_id (an artboard or layer) or image (an image layer id or a bogen-asset: src).');
    let src = image?.startsWith('bogen-asset:') ? image : undefined;
    let found: { fileId: string; nodeId: string; url?: string; name: string; type?: Reference['type'] } | undefined;
    if (node_id || (image && !src)) {
      const room = await ctx.room(file_id);
      const id = (node_id ?? image)!;
      const node = room.doc.getNode(id);
      if (!node) throw new Error(`No layer with id ${id}. Call layer_tree to see what exists.`);
      if (!node_id) {
        if (!node.src?.startsWith('bogen-asset:')) throw new Error('That layer has no stored image. Pass an image layer, or upload the picture with asset_upload and pass its src.');
        src = node.src;
      } else {
        const shot = await ctx.app.renderer.screenshot(room.doc, { nodeIds: [id] }, { format: 'png', maxDimension: MAX_SHOT });
        src = (await ctx.app.storage.putAsset(shot.bytes, 'image/png')).src;
        const tokens = new Map(room.doc.getTokens().map((t) => [t.name, t.value] as [string, string]));
        found = { fileId: room.id, nodeId: id, url: recordedCapture(room.doc, id)?.url, name: node.name, type: typeSummary(docTree(room.doc, id), tokens) };
      }
    }
    const palette = await imagePalette(ctx.app.storage, ctx.app.renderer, src!);
    const where = url ?? found?.url;
    const ref = ctx.app.references.add({
      title: title ?? found?.name ?? 'Picture', source: found?.url ? 'capture' : 'image', image: src, palette, tags,
      ...(where ? { url: where } : {}), ...(note ? { note } : {}),
      ...(found ? { fileId: found.fileId, nodeId: found.nodeId, ...(found.type ? { type: found.type } : {}) } : {}),
    });
    return { reference: forAgent(ref), notice: REFERENCE_NOTICE };
  });
}
