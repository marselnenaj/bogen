import {
  aspectRatioOf, CROP_ASPECTS, CROP_ATTR, croppedHeight, cropToAspect, formatCrop, parseCrop, parseImageFilters, withImageFilters,
  type BogenDoc, type BogenNode, type Crop, type CropAspect, type NewNode,
} from '@bogen/core';
import { z } from 'zod';
import { imageSize } from '../image-raster.ts';
import type { Storage } from '../storage.ts';
import { MAX_COLORS, MIN_COLORS, VECTORIZE_DETAILS, vectorizeAsset } from '../vectorize.ts';
import { assertUnlocked, fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

/** Crop, filters and vectorizing of image layers. The canvas has the same in the Image section of the inspector. */

function requireImage(doc: BogenDoc, id: string): BogenNode {
  const node = doc.getNode(id);
  if (!node) throw new Error(`No layer with id ${id}. Call layer_tree to see what exists.`);
  if (node.type !== 'image') throw new Error(`${node.name} is a ${node.type} layer, not an image. Pass the id of an image layer: layer_find with type "image" lists them.`);
  if (!node.src) throw new Error(`${node.name} has no image yet. Set its src first.`);
  return node;
}

/** The pixel size of a stored image, read from its header. Images elsewhere on the web are not fetched for it. */
export async function naturalSize(storage: Storage, src: string): Promise<{ width: number; height: number } | null> {
  const name = /^bogen-asset:(.+)$/.exec(src)?.[1];
  if (!name) return null;
  const asset = await storage.readAsset(name);
  return asset ? imageSize(asset.bytes) : null;
}

/** The width the layer has on the canvas: its own in px, or as the renderer lays it out. */
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

const filterArg = (label: string, unit: string, min: number, max: number) => z.number().min(min).max(max).nullable().optional().describe(`${label} in ${unit}. null takes it away.`);

export function registerImageTools(define: ToolDefiner): void {
  define('image_crop', { description: `Crop an image layer: the part of the image it shows, as fractions of the whole image (x, y, w, h from 0 to 1), or an aspect preset (${CROP_ASPECTS.join(', ')}) that takes the largest centred crop of that shape. It is stored on the layer and written as plain CSS (the image as a background, sized and placed in percentages), so it survives HTML, React, SVG and PNG export and follows the layer when it is resized. By default the layer's height follows, so the crop shows undistorted at its width. reset takes the crop away. The person has the same with handles on the canvas.` }, {
    node_id: z.string().describe('The image layer.'),
    aspect: z.enum(CROP_ASPECTS).optional().describe('free keeps the crop as it is; original is the image\'s own shape.'),
    crop: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0.01).max(1), h: z.number().min(0.01).max(1) }).optional().describe('Fractions of the image: {"x":0.25,"y":0,"w":0.5,"h":1} shows the middle half.'),
    reset: z.boolean().optional().describe('Show the whole image again.'),
    fit_height: z.boolean().default(true).describe('Set the layer height so the crop is not stretched. Needs an image stored in Bogen.'),
    file_id: fileIdArg,
  }, async ({ node_id, aspect, crop, reset, fit_height, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const node = requireImage(room.doc, node_id);
    assertUnlocked(room.doc, [node_id]);
    if ([aspect, crop, reset].filter((v) => v !== undefined && v !== false).length !== 1) throw new Error('Give one of aspect, crop or reset.');
    const attrs = { ...(node.attrs ?? {}) };
    if (reset) {
      delete attrs[CROP_ATTR];
      ctx.write(room, () => room.doc.updateFields(node_id, { attrs: Object.keys(attrs).length ? attrs : undefined }));
      ctx.touch([node_id]);
      return { id: node_id, crop: null };
    }
    const natural = await naturalSize(ctx.app.storage, node.src!);
    let next: Crop;
    if (aspect) {
      if (!natural) throw new Error('An aspect preset needs the image\'s size, which only images stored in Bogen have. Give crop as fractions, or upload the image with asset_upload.');
      const ratio = aspectRatioOf(aspect as CropAspect, natural);
      next = ratio === null ? parseCrop(attrs[CROP_ATTR]) ?? { x: 0, y: 0, w: 1, h: 1 } : cropToAspect(parseCrop(attrs[CROP_ATTR]), ratio, natural);
    } else next = crop!;
    if (next.x + next.w > 1.0001 || next.y + next.h > 1.0001) throw new Error(`The crop reaches past the image: x + w is ${+(next.x + next.w).toFixed(3)} and y + h is ${+(next.y + next.h).toFixed(3)}, and both must be at most 1. Make w or h smaller, or move x or y back.`);
    const value = formatCrop(next);
    const style: Record<string, string> = {};
    let note: string | undefined;
    if (fit_height) {
      const width = natural ? await layerWidth(ctx, room.doc, node) : null;
      if (width && natural) style.height = `${croppedHeight(width, next, natural)}px`;
      else note = natural ? 'The layer\'s width could not be measured, so its height stayed.' : 'The image is not stored in Bogen, so its size is unknown and the layer\'s height stayed. Set it with layer_style so the crop is not stretched.';
    }
    const whole = !parseCrop(value);
    if (whole) delete attrs[CROP_ATTR];
    else attrs[CROP_ATTR] = value;
    ctx.write(room, () => {
      room.doc.updateFields(node_id, { attrs: Object.keys(attrs).length ? attrs : undefined });
      if (Object.keys(style).length) room.doc.updateStyle(node_id, style);
    });
    ctx.touch([node_id]);
    return { id: node_id, crop: whole ? null : value, ...(style.height ? { height: style.height } : {}), ...(natural ? { image: natural } : {}), ...(note ? { note } : {}) };
  });

  define('image_filter', { description: 'Adjust an image (or any layer) with CSS filters: brightness, contrast and saturation in percent (100 is unchanged), blur in px and grayscale in percent (0 is unchanged). They are the layer\'s own filter style, so every export keeps them, and other filter functions already there (such as drop-shadow) stay. null or the neutral value takes one away; reset takes all five away.' }, {
    node_id: z.string(),
    brightness: filterArg('Brightness', 'percent', 0, 200),
    contrast: filterArg('Contrast', 'percent', 0, 200),
    saturation: filterArg('Saturation', 'percent', 0, 200),
    blur: filterArg('Blur', 'px', 0, 50),
    grayscale: filterArg('Grayscale', 'percent', 0, 100),
    reset: z.boolean().optional(),
    file_id: fileIdArg,
  }, async ({ node_id, brightness, contrast, saturation, blur, grayscale, reset, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const node = room.doc.getNode(node_id);
    if (!node) throw new Error(`No layer with id ${node_id}. Call layer_tree to see what exists.`);
    assertUnlocked(room.doc, [node_id]);
    const patch = reset
      ? { brightness: null, contrast: null, saturate: null, blur: null, grayscale: null }
      : { brightness, contrast, saturate: saturation, blur, grayscale };
    if (Object.values(patch).every((v) => v === undefined)) throw new Error('Give at least one filter, or reset.');
    const filter = withImageFilters(node.style.filter, patch);
    ctx.write(room, () => room.doc.updateStyle(node_id, { filter }));
    ctx.touch([node_id]);
    const now = parseImageFilters(filter ?? undefined);
    return { id: node_id, filter, brightness: now.brightness ?? 100, contrast: now.contrast ?? 100, saturation: now.saturate ?? 100, blur: now.blur ?? 0, grayscale: now.grayscale ?? 0 };
  });

  define('image_vectorize', { description: `Trace an image layer into an editable SVG layer, on this computer (imagetracerjs, in a worker): flat shapes in at most colors colours, with more or fewer of them by detail. The result is sanitized like any SVG, and goes next to the image (or in its place with replace), sized to the layer's width at the image's own shape. Works for images stored in Bogen: PNG, JPEG, WebP, GIF and AVIF. Good for logos, icons, flat illustrations and posterized looks; photos make many paths. Then edit fills and paths as for any vector.` }, {
    node_id: z.string().describe('The image layer.'),
    colors: z.number().int().min(MIN_COLORS).max(MAX_COLORS).default(8).describe('How many colours the vector has at most.'),
    detail: z.enum(VECTORIZE_DETAILS).default('medium').describe('low drops small shapes and smooths edges; high keeps them.'),
    replace: z.boolean().default(false).describe('Put the vector in place of the image, which is deleted (agent_undo brings it back).'),
    file_id: fileIdArg,
  }, async ({ node_id, colors, detail, replace, file_id }, ctx) => {
    if (ctx.dryRun) throw new Error('image_vectorize runs the tracer, so it does not run in a dry run.');
    const room = await ctx.room(file_id);
    const node = requireImage(room.doc, node_id);
    assertUnlocked(room.doc, [node_id]);
    const traced = await vectorizeAsset(ctx.app.storage, ctx.app.renderer, node.src!, { colors, detail });
    const width = (await layerWidth(ctx, room.doc, node)) ?? Math.min(traced.width, 800);
    const spec = vectorLayer(node, traced, width, replace);
    const id = ctx.write(room, () => {
      const siblings = room.doc.getChildren(node.parent);
      const at = siblings.findIndex((s) => s.id === node_id);
      const made = room.doc.insert(node.parent, spec, replace ? at : at + 1);
      if (replace) room.doc.delete([node_id]);
      return made;
    });
    ctx.touch([id]);
    return { id, name: spec.name, colors: traced.colors, paths: traced.paths, kb: Math.round(traced.bytes / 102.4) / 10, image: { width: traced.width, height: traced.height }, replaced: replace, next: 'Look at it with canvas_screenshot. Change fills with layer_attrs on the svg layer, or try fewer colours or less detail for a cleaner result.' };
  });
}

/** The traced layer: the image's width, its own shape, and where the image is unless it sits in a flow. */
export function vectorLayer(image: BogenNode, traced: { svg: string; width: number; height: number }, width: number, replace: boolean): NewNode {
  const height = Math.round((width * traced.height) / Math.max(1, traced.width));
  const style: Record<string, string> = { width: `${Math.round(width)}px`, height: `${height}px`, flexShrink: '0' };
  if (image.style.position === 'absolute') {
    style.position = 'absolute';
    const left = /^(-?[\d.]+)px$/.exec(image.style.left ?? '')?.[1];
    if (image.style.top) style.top = image.style.top;
    // Beside the image rather than over it, so both can be compared.
    if (left !== undefined) style.left = replace ? `${left}px` : `${Number(left) + width + 24}px`;
    else if (image.style.left) style.left = image.style.left;
  }
  return { type: 'svg', tag: 'svg', name: `${image.name} (vector)`, svg: traced.svg, style, attrs: image.attrs?.alt ? { 'aria-label': image.attrs.alt } : undefined };
}
