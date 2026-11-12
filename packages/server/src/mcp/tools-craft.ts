import { bulkRename, defaultLayoutGrid, describeLayoutGrid, findText, LAYOUT_GRID_ALIGNS, LAYOUT_GRID_KINDS, MAX_LAYOUT_GRIDS, replaceText, type LayoutGrid } from '@bogen/core';
import { z } from 'zod';
import { assertUnlocked, fileIdArg, type ToolDefiner } from './kit.ts';

const gridShape = z.object({
  kind: z.enum(LAYOUT_GRID_KINDS as [LayoutGrid['kind'], ...LayoutGrid['kind'][]]),
  count: z.number().int().min(1).max(200).optional().describe('Columns or rows: how many. Default 12 columns on a desktop frame, 8 on a tablet, 4 on a phone.'),
  gutter: z.number().min(0).max(2000).optional().describe('Columns or rows: px between two.'),
  margin: z.number().min(-2000).max(2000).optional().describe('Columns or rows: px free at both edges when stretched, or the offset from the edge they align to.'),
  align: z.enum(LAYOUT_GRID_ALIGNS as [LayoutGrid['align'] & string, ...string[]]).optional().describe('stretch fills the frame; start, center and end keep size.'),
  size: z.number().min(1).max(4000).optional().describe('A grid\'s cell in px, or the width of a column (height of a row) when not stretched.'),
  color: z.string().max(60).optional().describe('A CSS colour for this grid on the canvas, such as rgba(255,0,0,0.1).'),
  hidden: z.boolean().optional(),
});

export function registerCraftTools(define: ToolDefiner): void {
  define('layout_grid_set', { description: 'Set the layout grids of frames: columns, rows or a square grid that the person sees over the frame on the canvas, and that moving and resizing snap to. They are a guide for the design and are never exported. kind "columns" with no other values picks 12 columns on a desktop width, 8 on a tablet and 4 on a phone. Pass grids [] to remove them. Use it on an artboard before you lay out a page on a column grid, and keep the columns in your html_write (padding as the margin, gap as the gutter).' }, {
    node_ids: z.array(z.string()).min(1).max(100),
    grids: z.array(gridShape).max(MAX_LAYOUT_GRIDS).describe('The whole list, replacing what is there. Missing values take the defaults for the frame\'s width.'),
    file_id: fileIdArg,
  }, async ({ node_ids, grids, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const doc = room.doc;
    for (const id of node_ids) {
      const n = doc.getNode(id);
      if (!n) throw new Error(`No layer with id ${id}. Call layer_tree to see what exists.`);
      if (n.type !== 'frame') throw new Error(`Layer ${id} is a ${n.type}. Layout grids go on frames.`);
    }
    assertUnlocked(doc, node_ids);
    const out: Record<string, { grids: LayoutGrid[]; described: string[] }> = {};
    ctx.write(room, () => {
      for (const id of node_ids) {
        const width = Number.parseFloat(doc.getNode(id)?.style.width ?? '') || 1440;
        const full = grids.map((g) => ({ ...defaultLayoutGrid(g.kind, width), ...Object.fromEntries(Object.entries(g).filter(([, v]) => v !== undefined)) }));
        doc.updateFields(id, { layoutGrids: full });
        const stored = doc.getNode(id)?.layoutGrids ?? [];
        out[id] = { grids: stored, described: stored.map(describeLayoutGrid) };
      }
    });
    ctx.touch(node_ids);
    return { updated: node_ids.length, layers: out };
  });

  define('text_replace', { description: 'Find text across the file, or a page or some layers, and replace it, as one undo step. Matching ignores case unless case_sensitive; whole_word skips matches inside longer words. The new words keep the look of the words they replace, including bold or coloured ranges. Text inside an instance comes from its main, so replace in the main. Locked layers are skipped and listed. dry_run lists the matches without changing anything. For one layer\'s whole text use layer_text.' }, {
    find: z.string().min(1).max(1000),
    replace: z.string().max(5000).default(''),
    case_sensitive: z.boolean().default(false),
    whole_word: z.boolean().default(false),
    page_id: z.string().optional().describe('Only this page. Default is the whole file.'),
    within: z.array(z.string()).max(200).optional().describe('Only inside these layers.'),
    dry_run: z.boolean().default(false),
    file_id: fileIdArg,
  }, async ({ find, replace, case_sensitive, whole_word, page_id, within, dry_run, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const search = { query: find, caseSensitive: case_sensitive, wholeWord: whole_word };
    const scope = { ...(page_id ? { pageId: page_id } : {}), ...(within?.length ? { within } : {}) };
    if (page_id && !room.doc.pages.has(page_id)) throw new Error(`No page with id ${page_id}. Call page_list.`);
    const hits = findText(room.doc, search, scope);
    const matches = hits.map((h) => ({ id: h.id, page_id: h.pageId, name: h.name, count: h.at.length, text: h.text.slice(0, 160), ...(h.locked ? { locked: true } : {}) }));
    if (dry_run) return { matches: hits.reduce((n, h) => n + h.at.length, 0), layers: matches };
    const result = ctx.write(room, () => replaceText(room.doc, search, replace, scope));
    ctx.touch(result.layers);
    return { replaced: result.replaced, layers: result.layers, ...(result.skipped.length ? { skipped: result.skipped } : {}) };
  });

  define('layers_rename', { description: 'Rename several layers at once, as one undo step. pattern names each layer in the order of node_ids: $& is its current name, $n counts up from start (default 1), $N counts down, and $nn or $NN pad with zeros, so "Card $n" gives Card 1, Card 2. find and replace change text inside the names first. For one layer, layer_rename does the same.' }, {
    node_ids: z.array(z.string()).min(1).max(500),
    pattern: z.string().max(200).optional(),
    find: z.string().max(200).optional(),
    replace: z.string().max(200).optional(),
    case_sensitive: z.boolean().default(false),
    start: z.number().int().min(-100000).max(100000).default(1),
    file_id: fileIdArg,
  }, async ({ node_ids, pattern, find, replace, case_sensitive, start, file_id }, ctx) => {
    if (!pattern && !find) throw new Error('Give a pattern, such as "Card $n", or find and replace.');
    const room = await ctx.room(file_id);
    const nodes = node_ids.map((id) => {
      const n = room.doc.getNode(id);
      if (!n) throw new Error(`No layer with id ${id}. Call layer_tree to see what exists.`);
      return n;
    });
    const names = bulkRename(nodes.map((n) => n.name), { ...(pattern ? { pattern } : {}), ...(find ? { find, replace: replace ?? '' } : {}), caseSensitive: case_sensitive, start });
    ctx.write(room, () => nodes.forEach((n, i) => { if (names[i] !== n.name) room.doc.updateFields(n.id, { name: names[i]! }); }));
    ctx.touch(node_ids);
    return { renamed: nodes.filter((n, i) => names[i] !== n.name).length, layers: nodes.map((n, i) => ({ id: n.id, name: names[i] })) };
  });
}
