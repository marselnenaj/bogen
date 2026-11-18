import { brandLinkOf, normalizeColor, resolveBrandColor, sanitizeSvgMarkup, upsertBrandItem, type BogenDoc, type BogenNode, type BrandData, type BrandTreatment, type NewNode } from '@bogen/core';
import { z } from 'zod';
import {
  applyTreatment, coerceTreatmentParams, DITHER_KINDS, DROP_KINDS, FALLOFF_FROM, INK_BY, svgCapable, TREATMENT_DEFAULTS, TREATMENT_MODES, TREATMENT_SHAPES,
  type Ink, type TreatmentParams,
} from '../image-treatment.ts';
import { encodePng } from '../pdf-import.ts';
import { assetPixels } from '../vectorize.ts';
import { assertUnlocked, fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/**
 * image_treatment: a photo in a brand's colours, as halftone, mosaic, dither, duotone or posterize, deterministic and
 * on this computer (image-treatment.ts). A named preset lives in the brand, so every photo of the brand gets the
 * same look; the brand book shows each preset with an example before and after.
 */

/** Pixels the photo is read at: plenty for cells of a few pixels at the widest output. */
const READ_PIXELS = 1_600_000;
const DEFAULT_WIDTH = 1200;

const settingsShape = z.object({
  grid: z.number().min(1).max(400).optional().describe('halftone and mosaic: cell size; dither: size of one dither pixel. In output pixels. Default 12.'),
  shape: z.enum(TREATMENT_SHAPES).optional().describe('halftone: dot, square, cell (rounded square) or line. Default dot.'),
  angle: z.number().min(-360).max(360).optional().describe('halftone: grid angle in degrees. Default 45; 0 for an upright grid.'),
  dither: z.enum(DITHER_KINDS).optional().describe('dither: bayer4 or bayer8 (ordered, a regular pattern), floyd-steinberg or atkinson (error diffusion, grainier). Default bayer4.'),
  inkBy: z.enum(INK_BY).optional().describe('tone: inks by tone band, dark to light. region: the photo is split into as many colour regions as inks (k-means) and each region gets its own ink, so subject and background differ. Default tone.'),
  contrast: z.number().min(-100).max(100).optional(),
  brightness: z.number().min(-100).max(100).optional(),
  invert: z.boolean().optional(),
  levels: z.boolean().optional().describe('Stretch the photo\'s own tones to the full range first. Default true.'),
  maxSize: z.number().min(0.05).max(1.5).optional().describe('halftone and mosaic: the largest shape as a share of its cell. Default 1.'),
  minSize: z.number().min(0).max(1).optional().describe('Shapes smaller than this share are left out, which keeps light areas clean. Default 0.04.'),
  gap: z.number().min(0).max(0.9).optional().describe('mosaic: the gap between pixels as a share of the cell. Default 0.12.'),
  sparse: z.number().min(0).max(1).optional().describe('mosaic: 0 keeps every cell; toward 1 the parts that blend into the ground dissolve into scattered pixels.'),
  drop: z.enum(DROP_KINDS).optional().describe('What is left out: light or dark tones past threshold, the colour around the border (a plain backdrop), or dropColor. Default none.'),
  threshold: z.number().min(0).max(1).optional(),
  dropColor: z.string().max(40).optional(),
  tolerance: z.number().min(0).max(1).optional().describe('For drop border and color: how near a colour is left out. Default 0.12.'),
  falloff: z.enum(FALLOFF_FROM).optional().describe('Cells thin out toward this side, the centre or the edges, for a picture that dissolves into the page.'),
  falloffAmount: z.number().min(0).max(1).optional(),
  seed: z.number().int().min(0).max(2 ** 31).optional().describe('The same seed gives the same scatter every time.'),
}).strict();

function requireImage(doc: BogenDoc, id: string): BogenNode {
  const node = doc.getNode(id);
  if (!node) throw new Error(`No layer with id ${id}. Call layer_tree to see what exists.`);
  if (node.type !== 'image') throw new Error(`${node.name} is a ${node.type} layer, not an image. Pass the id of an image layer: layer_find with type "image" lists them.`);
  if (!node.src) throw new Error(`${node.name} has no image yet. Set its src first.`);
  return node;
}

/** The file's own colour tokens by name, for inks given as a token. */
function colorTokens(doc: BogenDoc): Map<string, string> {
  return new Map(doc.getTokens().filter((t) => t.kind === 'color').map((t) => [t.name, t.value]));
}

/**
 * An ink from what an agent or a preset names: a brand colour (id, name, role or token), a colour token of the file
 * (name, --name or var(--name)), or a CSS colour. Brand and token colours keep their token, so the result follows them.
 */
export function resolveInk(spec: string, brand: BrandData | null, tokens: Map<string, string>): Ink {
  const raw = spec.trim();
  const tokenName = /^var\(\s*--([\w-]+)\s*(?:,[^)]*)?\)$/.exec(raw)?.[1] ?? /^--([\w-]+)$/.exec(raw)?.[1];
  if (brand && !tokenName) {
    const c = resolveBrandColor(brand, raw);
    if (c) return { color: c.value.slice(0, 7), token: c.token };
  }
  const name = tokenName ?? raw;
  const value = tokens.get(name);
  if (value) {
    const hex = normalizeColor(value);
    if (hex) return { color: hex.slice(0, 7), token: name };
  }
  if (brand && tokenName) {
    const c = brand.colors.find((x) => x.token === tokenName);
    if (c) return { color: c.value.slice(0, 7), token: c.token };
  }
  const hex = normalizeColor(raw);
  if (hex) return { color: hex.slice(0, 7) };
  const known = brand?.colors.map((c) => c.name).slice(0, 12).join(', ');
  throw new Error(`"${spec}" is not a colour: give a brand colour${known ? ` (${known})` : ''}, a colour token of the file, or a CSS colour.`);
}

async function linkedBrand(ctx: ToolContext, doc: BogenDoc, brandId?: string): Promise<{ id: string; data: BrandData } | null> {
  const id = brandId ?? brandLinkOf(doc)?.id;
  if (!id) return null;
  if (ctx.app.storage.get(id)?.kind !== 'brand') throw new Error(`There is no brand ${id}. brand_list lists them.`);
  const { data } = await ctx.app.brands.read(id);
  return { id, data };
}

/**
 * Gives one photo a treatment saved in the brand and stores the result as a picture, for places that need an image
 * source rather than a layer (brand_presentation's photography). Answers the new bogen-asset src.
 */
export async function treatPhotoWithPreset(ctx: ToolContext, doc: BogenDoc, brand: BrandData, src: string, presetName: string, width = 1600): Promise<string> {
  const preset = findPreset(brand, presetName);
  if (!preset) throw new Error(`The brand has no treatment "${presetName}". It has: ${brand.treatments.map((t) => t.name).join(', ') || 'none yet'}.`);
  const params = coerceTreatmentParams({ ...preset.params, mode: preset.mode });
  const tokens = colorTokens(doc);
  if (!preset.inks.length) throw new Error(`The treatment "${preset.name}" names no inks.`);
  const inks = preset.inks.map((spec) => resolveInk(spec, brand, tokens));
  const ground = preset.ground && preset.ground !== 'none' ? resolveInk(preset.ground, brand, tokens) : undefined;
  const image = await assetPixels(ctx.app.storage, ctx.app.renderer, src, READ_PIXELS);
  const result = applyTreatment({ image, params, inks, ground, width: Math.min(width, Math.max(image.width, 400)) }, { svg: false });
  if (result.kind !== 'raster') throw new Error('The treatment gave no picture.');
  const stored = await ctx.app.storage.putAsset(encodePng(result.width, result.height, new Uint8Array(result.rgba.buffer, result.rgba.byteOffset, result.rgba.byteLength)), 'image/png');
  return stored.src;
}

function findPreset(brand: BrandData, name: string): BrandTreatment | undefined {
  const key = name.trim().toLowerCase();
  return brand.treatments.find((t) => t.id === name) ?? brand.treatments.find((t) => t.name.toLowerCase() === key);
}

/** The treated layer: beside the photo for comparison, or in its place with replace. */
function treatedLayer(image: BogenNode, spec: { type: 'svg'; svg: string } | { type: 'image'; src: string }, width: number, height: number, replace: boolean, name: string): NewNode {
  const style: Record<string, string> = { width: `${Math.round(width)}px`, height: `${Math.round(height)}px`, flexShrink: '0' };
  if (image.style.position === 'absolute') {
    style.position = 'absolute';
    const left = /^(-?[\d.]+)px$/.exec(image.style.left ?? '')?.[1];
    if (image.style.top) style.top = image.style.top;
    if (left !== undefined) style.left = replace ? `${left}px` : `${Number(left) + width + 24}px`;
    else if (image.style.left) style.left = image.style.left;
  }
  const alt = image.attrs?.alt;
  if (spec.type === 'svg') return { type: 'svg', tag: 'svg', name, svg: spec.svg, style, attrs: alt ? { 'aria-label': alt, role: 'img' } : undefined };
  return { type: 'image', tag: 'img', name, src: spec.src, style: { ...style, objectFit: 'cover' }, attrs: alt ? { alt } : undefined };
}

async function layerWidth(ctx: ToolContext, doc: BogenDoc, node: BogenNode): Promise<number | null> {
  const own = /^([\d.]+)px$/.exec(node.style.width ?? '')?.[1];
  if (own) return Number(own);
  try {
    const entries = await ctx.app.renderer.layout(doc, { nodeIds: [node.id] }, [node.id]);
    return entries[0]?.width || null;
  } catch {
    return null;
  }
}

export function registerTreatmentTools(define: ToolDefiner): void {
  define('image_treatment', {
    description: `Turn a photo into the brand's colours, deterministically on this computer: halftone (dots, squares, rounded cells or lines on a rotated grid, sized by tone), mosaic (square pixels that can dissolve toward a side), dither (ordered or error diffusion), duotone (a ramp through two or three inks) or posterize (flat tone bands or colour regions). Inks are brand colours, colour tokens or CSS colours; with inkBy region the subject and the background each get their own ink. halftone, mosaic and dither give an editable SVG layer whose fills are var(--token), so the picture follows a change of the brand colour; duotone and posterize give a PNG image layer. The result goes beside the photo, or in its place with replace. preset applies a treatment saved in the brand, so every photo has the same look; save_preset stores this one in the brand (as a suggestion unless the person confirmed it), with this photo before and after for the brand book. Settings: ${Object.keys(TREATMENT_DEFAULTS).filter((k) => k !== 'mode').join(', ')}.`,
  }, {
    node_id: z.string().describe('The image layer with the photo.'),
    preset: z.string().max(200).optional().describe('Name or id of a treatment saved in the brand. Other arguments given change it for this call.'),
    mode: z.enum(TREATMENT_MODES).optional().describe('Required without preset.'),
    inks: z.array(z.string().max(80)).min(1).max(8).optional().describe('The colours of the shapes or bands, any order: sorted dark to light. Brand colour names or roles, tokens, or CSS colours.'),
    ground: z.string().max(80).optional().describe('Painted under everything: a colour as for inks, or "none" for transparent.'),
    settings: settingsShape.optional(),
    output: z.enum(['svg', 'raster']).optional().describe('svg (default for halftone, mosaic and dither) or raster (a PNG).'),
    width: z.number().min(64).max(4096).optional().describe('Width of the result in px; the height follows the photo. Default the photo layer\'s width.'),
    replace: z.boolean().default(false).describe('Put the result in place of the photo, which is deleted (agent_undo brings it back).'),
    brand_id: z.string().optional().describe('The brand for preset, brand colours and save_preset. Default the brand the file is linked to.'),
    save_preset: z.object({ name: z.string().min(1).max(200), confirmed: z.boolean().default(false).describe('True only when the person told you to keep this treatment.') }).optional(),
    file_id: fileIdArg,
  }, async (args, ctx) => {
    if (ctx.dryRun) throw new Error('image_treatment reads and writes pixels, so it does not run in a dry run.');
    const room = await ctx.room(args.file_id);
    const node = requireImage(room.doc, args.node_id);
    if (args.replace) assertUnlocked(room.doc, [args.node_id]);
    const brand = await linkedBrand(ctx, room.doc, args.brand_id);
    let preset: BrandTreatment | undefined;
    if (args.preset) {
      if (!brand) throw new Error('A preset lives in a brand, and this file links to none: pass brand_id, or link the file with brand_link.');
      preset = findPreset(brand.data, args.preset);
      if (!preset) throw new Error(`The brand has no treatment "${args.preset}". It has: ${brand.data.treatments.map((t) => t.name).join(', ') || 'none yet'}.`);
    }
    const mode = args.mode ?? (preset?.mode as TreatmentParams['mode'] | undefined);
    if (!mode) throw new Error('Give mode (halftone, mosaic, dither, duotone or posterize) or a preset.');
    const params: TreatmentParams = coerceTreatmentParams({ ...(preset?.params ?? {}), ...(args.settings ?? {}), mode });
    const tokens = colorTokens(room.doc);
    const inkSpecs = args.inks ?? preset?.inks ?? [];
    if (!inkSpecs.length) throw new Error('Give inks: one or more brand colours, tokens or CSS colours.');
    const inks = inkSpecs.map((s) => resolveInk(s, brand?.data ?? null, tokens));
    const groundSpec = args.ground ?? preset?.ground ?? '';
    const ground = groundSpec && groundSpec !== 'none' ? resolveInk(groundSpec, brand?.data ?? null, tokens) : undefined;
    const output = args.output ?? (preset?.output as 'svg' | 'raster' | undefined) ?? (svgCapable(mode) ? 'svg' : 'raster');
    if (output === 'svg' && !svgCapable(mode)) throw new Error(`${mode} gives pixels: use output raster, or halftone, mosaic or dither for an SVG.`);
    const image = await assetPixels(ctx.app.storage, ctx.app.renderer, node.src!, READ_PIXELS);
    const width = args.width ?? (await layerWidth(ctx, room.doc, node)) ?? Math.min(image.width, DEFAULT_WIDTH);
    const result = applyTreatment({ image, params, inks, ground, width }, { svg: output === 'svg' });
    let spec: { type: 'svg'; svg: string } | { type: 'image'; src: string };
    let after: string | undefined;
    if (result.kind === 'svg') spec = { type: 'svg', svg: sanitizeSvgMarkup(result.svg) };
    else {
      const stored = await ctx.app.storage.putAsset(encodePng(result.width, result.height, new Uint8Array(result.rgba.buffer, result.rgba.byteOffset, result.rgba.byteLength)), 'image/png');
      spec = { type: 'image', src: stored.src };
      after = stored.src;
    }
    const name = `${node.name} (${preset?.name ?? args.save_preset?.name ?? mode})`;
    const layer = treatedLayer(node, spec, width, (width * result.height) / result.width, args.replace, name);
    const id = ctx.write(room, () => {
      const siblings = room.doc.getChildren(node.parent);
      const at = siblings.findIndex((s) => s.id === args.node_id);
      const made = room.doc.insert(node.parent, layer, args.replace ? at : at + 1);
      if (args.replace) room.doc.delete([args.node_id]);
      return made;
    });
    ctx.touch([id]);
    let saved: { brand_id: string; id: string; suggested: boolean } | undefined;
    if (args.save_preset) {
      if (!brand) throw new Error('The treatment was applied, but there is no brand to save it in: pass brand_id, or link the file with brand_link.');
      // The brand book shows an example pair: this photo, and the result as a picture at a size that loads fast.
      if (!after) {
        const thumb = applyTreatment({ image, params, inks, ground, width: Math.min(800, width) }, { svg: false });
        if (thumb.kind === 'raster') after = (await ctx.app.storage.putAsset(encodePng(thumb.width, thumb.height, new Uint8Array(thumb.rgba.buffer, thumb.rgba.byteOffset, thumb.rgba.byteLength)), 'image/png')).src;
      }
      const brandRoom = await ctx.app.brands.room(brand.id);
      // Only what differs from the defaults, so the brand book shows the choices that make the look.
      const rest = Object.fromEntries(Object.entries(params).filter(([k, v]) => k !== 'mode' && v !== TREATMENT_DEFAULTS[k as keyof TreatmentParams]));
      const existing = findPreset(brand.data, args.save_preset.name);
      const itemId = ctx.write(brandRoom, () => upsertBrandItem(brandRoom.doc, 'treatments', {
        ...(existing ? { id: existing.id } : {}), name: args.save_preset!.name, mode, params: rest as Record<string, string | number | boolean>,
        inks: inkSpecs, ground: groundSpec === 'none' ? '' : groundSpec, output, before: node.src, ...(after ? { after } : {}),
        suggested: !args.save_preset!.confirmed,
      }));
      saved = { brand_id: brand.id, id: itemId, suggested: !args.save_preset.confirmed };
    }
    return {
      id, name, kind: result.kind === 'svg' ? 'svg' : 'image', width: result.width, height: result.height,
      ...(result.kind === 'svg' ? { shapes: result.shapes, kb: Math.round(result.bytes / 102.4) / 10 } : { src: (spec as { src: string }).src }),
      inks: inks.map((i) => (i.token ? `--${i.token} ${i.color}` : i.color)), ...(ground ? { ground: ground.token ? `--${ground.token} ${ground.color}` : ground.color } : {}),
      ...(saved ? { saved_preset: saved } : {}),
      next: 'Look at it with canvas_screenshot beside the photo. Change grid, inks or inkBy and call again; when it is right, save_preset keeps it in the brand.',
    };
  });
}

