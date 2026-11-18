import {
  PATTERN_ATTR, PATTERN_CELLS, PATTERN_DEFAULTS, PATTERN_FIELD_ATTR, PATTERN_FIGURES, PATTERN_FILLS, confirmed, decodeField, encodeField, normalizePatternSpec, readPatternSpec, renderPattern,
  type BogenNode, type NewNode, type PatternSpec,
} from '@bogen/core';
import { z } from 'zod';
import { imageField, textField } from '../pattern-sample.ts';
import { fontFor, parseFont, publicFetch } from '../text-outline.ts';
import { assetPixels } from '../vectorize.ts';
import { assertUnlocked, fileIdArg, pageIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/** Pattern layers: a brand's graphic device drawn as cells, editable, in its tokens, exported as vector. */

const specArgs = {
  columns: z.number().int().min(1).max(400).optional().describe('Cells across.'),
  rows: z.number().int().min(1).max(400).optional().describe('Cells down. Match columns : rows to the layer\'s shape so cells stay square.'),
  cell: z.enum(PATTERN_CELLS).optional(),
  path: z.string().max(4000).optional().describe('For cell custom: SVG path data in a 0..1 box, such as a seedling or a pixel of the logo.'),
  gap: z.number().min(0).max(0.9).optional().describe('Share of each cell left empty around its shape.'),
  fill: z.enum(PATTERN_FILLS).optional().describe('Where the cells fill: solid everywhere, gradient along angle, radial from cx/cy, noise, figure (the cells form a shape: the texture as a figure), bars (the cells as a bar chart of values), image (dark parts fill), text (the letters fill).'),
  figure: z.enum(PATTERN_FIGURES).optional().describe('For fill figure.'),
  values: z.array(z.number().min(0).max(1)).max(64).optional().describe('For fill bars: one height per bar, 0 to 1. A chart in the brand\'s own material.'),
  angle: z.number().min(-360).max(360).optional().describe('gradient: 0 runs left to right, 90 top to bottom.'),
  cx: z.number().min(-1).max(2).optional(),
  cy: z.number().min(-1).max(2).optional(),
  radius: z.number().min(0.01).max(4).optional().describe('radial: as a share of the width.'),
  scale: z.number().min(1).max(200).optional().describe('noise: size of its blobs in cells.'),
  roughness: z.number().min(0).max(1).optional().describe('Noise added to any fill, so its edge breaks into single cells like the reference stripes. 0 is a clean edge.'),
  threshold: z.number().min(0).max(0.999).optional().describe('Cells under this value stay empty.'),
  scatter: z.number().min(0).max(0.95).optional().describe('Share of cells left out at random.'),
  size_by_value: z.boolean().optional().describe('Cells grow with their value (a halftone), instead of all full size.'),
  min_size: z.number().min(0).max(1).optional(),
  invert: z.boolean().optional(),
  curve: z.number().min(0.1).max(10).optional().describe('Values raised to this power: under 1 fills more, over 1 less.'),
  colors: z.array(z.string().max(120)).min(1).max(8).optional().describe('One per tone, lowest value first: var(--token) so the pattern follows the brand, or colours.'),
  seed: z.number().int().min(0).optional().describe('Another seed gives another arrangement of the same pattern.'),
};

type SpecArgs = { [K in keyof typeof specArgs]?: z.infer<(typeof specArgs)[K]> };

function toSpec(args: SpecArgs): Partial<PatternSpec> {
  const out: Partial<PatternSpec> = {};
  const map: [keyof SpecArgs, keyof PatternSpec][] = [['figure', 'figure'], ['values', 'values'], ['columns', 'columns'], ['rows', 'rows'], ['cell', 'cell'], ['path', 'path'], ['gap', 'gap'], ['fill', 'fill'], ['angle', 'angle'], ['cx', 'cx'], ['cy', 'cy'], ['radius', 'radius'], ['scale', 'scale'], ['roughness', 'roughness'], ['threshold', 'threshold'], ['scatter', 'scatter'], ['size_by_value', 'sizeByValue'], ['min_size', 'minSize'], ['invert', 'invert'], ['curve', 'curve'], ['colors', 'colors'], ['seed', 'seed']];
  for (const [a, k] of map) if (args[a] !== undefined) (out as Record<string, unknown>)[k] = args[a];
  return out;
}

export function isPatternLayer(node: BogenNode | null | undefined): boolean {
  return Boolean(node && node.type === 'svg' && node.attrs?.[PATTERN_ATTR]);
}

async function brandPreset(ctx: ToolContext, room: Parameters<ToolContext['app']['brands']['forRoom']>[0], name: string): Promise<Partial<PatternSpec>> {
  const found = await ctx.app.brands.forRoom(room);
  const devices = found?.data ? confirmed(found.data.devices ?? []).concat((found.data.devices ?? []).filter((d) => d.suggested)) : [];
  const hit = devices.find((d) => d.id === name || d.name.toLowerCase() === name.toLowerCase());
  if (!hit) throw new Error(found?.data ? `The brand has no graphic device "${name}". It has: ${devices.map((d) => d.name).join(', ') || 'none'}. Add one with brand_update section devices.` : 'This file is not linked to a brand, so it has no graphic devices. Give the pattern\'s values instead, or brand_link first.');
  return JSON.parse(hit.spec) as Partial<PatternSpec>;
}

export function registerPatternTools(define: ToolDefiner): void {
  define('pattern_set', { description: `Draw a brand's graphic device as a pattern layer, or change one: a grid of cells (${PATTERN_CELLS.join(', ')}) that fill by a value field (${PATTERN_FILLS.join(', ')}), with tones in the brand's colours as var(--token), so it follows the brand and exports as vector. The same rule works in three registers: as texture or background, as a figure (fill figure: wave, mountain, tower, cloud, sun, hill), and as a chart style (fill bars), from a favicon to a billboard. Good for motifs that grow out of the brand idea: cells of a seed tray that fill from below (gradient 90, invert), pixels that break up at an edge (gradient with roughness), a dither of a photo in two brand colours (image, size_by_value), a word built of cells (text). Give node_id to change a pattern (only what you pass changes); else it is made at x/y on the page or in parent_id. preset takes a graphic device of the linked brand (brand_get lists them as graphic_devices). The fields are stored with the layer, so the person can tune it in the inspector. Look at it with canvas_screenshot and tune threshold, roughness and seed.` }, {
    node_id: z.string().optional().describe('A pattern layer to change.'),
    preset: z.string().optional().describe('A graphic device of the linked brand, by name or id, as the start.'),
    ...specArgs,
    image: z.string().optional().describe('fill image: an image layer id or a bogen-asset src. Its dark parts fill (invert for the light parts).'),
    text: z.string().max(200).optional().describe('fill text: the word or lines to build from cells.'),
    font_family: z.string().max(120).optional().describe('fill text: the family to set it in; by default the file\'s first brand font, or Inter.'),
    font_weight: z.number().int().min(100).max(900).optional(),
    width: z.number().min(1).max(20000).optional().describe('In px, for a new layer. Default 960.'),
    height: z.number().min(1).max(20000).optional().describe('In px; by default from columns : rows.'),
    x: z.number().optional(),
    y: z.number().optional(),
    parent_id: z.string().optional(),
    name: z.string().min(1).max(200).optional(),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async (args, ctx) => {
    if (ctx.dryRun) throw new Error('pattern_set samples images and fonts, so it does not run in a dry run.');
    const room = await ctx.room(args.file_id);
    const { doc } = room;
    const existing = args.node_id ? doc.getNode(args.node_id) : null;
    if (args.node_id && !existing) throw new Error(`No layer with id ${args.node_id}.`);
    if (existing && !isPatternLayer(existing)) throw new Error(`${existing.name} is not a pattern layer. Leave node_id out to make one.`);
    if (existing) assertUnlocked(doc, [existing.id]);
    const before = existing ? readPatternSpec(existing.attrs?.[PATTERN_ATTR]) ?? PATTERN_DEFAULTS : PATTERN_DEFAULTS;
    const preset = args.preset ? await brandPreset(ctx, room, args.preset) : {};
    const spec = normalizePatternSpec({ ...before, ...preset, ...toSpec(args) });
    let field: Float32Array | null = null;
    const notes: string[] = [];
    const resample = spec.fill === 'image' || spec.fill === 'text';
    const keepField = existing?.attrs?.[PATTERN_FIELD_ATTR] && !args.image && !args.text && before.columns === spec.columns && before.rows === spec.rows && before.fill === spec.fill;
    if (resample && keepField) field = decodeField(existing!.attrs![PATTERN_FIELD_ATTR]!, spec.columns * spec.rows);
    if (resample && !field) {
      if (spec.fill === 'image') {
        const ref = args.image ?? (existing ? JSON.parse(existing.attrs?.[PATTERN_ATTR] ?? '{}').image : undefined);
        if (!ref) throw new Error('fill image needs image: an image layer id or a bogen-asset src.');
        const src = ref.startsWith('bogen-asset:') ? ref : doc.getNode(ref)?.src;
        if (!src) throw new Error(`${ref} is not an image layer with an image, nor a bogen-asset src.`);
        const pixels = await assetPixels(ctx.app.storage, ctx.app.renderer, src, 160_000);
        field = imageField(pixels, spec.columns, spec.rows);
      } else {
        const text = args.text;
        if (!text?.trim()) throw new Error('fill text needs text: the word to build from cells.');
        const family = args.font_family ?? 'Inter';
        const font = await fontFor(doc, { storage: ctx.app.storage, fetch: publicFetch }, family, args.font_weight ?? 700, false, text);
        field = textField(await parseFont(font.bytes), text, spec.columns, spec.rows);
        notes.push(`Set in ${font.source}.`);
      }
    }
    const drawn = renderPattern(spec, field);
    if (!drawn.filled) notes.push('No cell is filled: lower threshold, or check the fill.');
    const stored = JSON.stringify({ ...spec, ...(spec.fill === 'image' && args.image ? { image: args.image } : {}), ...(spec.fill === 'text' && args.text ? { text: args.text } : {}) });
    const attrs: Record<string, string> = { ...(existing?.attrs ?? {}), [PATTERN_ATTR]: stored, role: 'img', 'aria-label': existing?.attrs?.['aria-label'] ?? (args.name ?? 'Pattern') };
    if (field) attrs[PATTERN_FIELD_ATTR] = encodeField(field);
    else delete attrs[PATTERN_FIELD_ATTR];
    const width = args.width ?? (existing ? undefined : 960);
    const height = args.height ?? (width ? Math.round((width * spec.rows) / spec.columns) : undefined);
    if (existing) {
      ctx.write(room, () => {
        doc.updateFields(existing.id, { svg: drawn.svg, attrs, ...(args.name ? { name: args.name } : {}) });
        if (width || args.height) doc.updateStyle(existing.id, { ...(width ? { width: `${width}px` } : {}), ...(height ? { height: `${height}px` } : {}) });
      });
      ctx.touch([existing.id]);
      return { id: existing.id, filled: drawn.filled, cells: drawn.cells, tones: drawn.tones, ...(notes.length ? { notes } : {}) };
    }
    const parent = args.parent_id ?? ctx.page(room, args.page_id);
    if (args.parent_id) assertUnlocked(doc, [args.parent_id]);
    const style: Record<string, string> = { width: `${width}px`, height: `${height}px`, flexShrink: '0', display: 'block' };
    if (args.x !== undefined || args.y !== undefined || doc.pages.has(parent)) {
      style.position = 'absolute';
      style.left = `${args.x ?? 0}px`;
      style.top = `${args.y ?? 0}px`;
    }
    const spec2: NewNode = { type: 'svg', tag: 'svg', name: args.name ?? (args.preset ? `Graphic device · ${args.preset}` : 'Pattern'), svg: drawn.svg, style, attrs };
    const id = ctx.write(room, () => doc.insert(parent, spec2));
    ctx.touch([id]);
    return { id, filled: drawn.filled, cells: drawn.cells, tones: drawn.tones, ...(notes.length ? { notes } : {}), next: 'Look at it with canvas_screenshot. To keep it as the brand\'s graphic device, brand_update section devices with its fields as spec.' };
  });
}
