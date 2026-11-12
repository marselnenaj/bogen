import { createComponent, CROP_ATTR, formatCrop, newId, sanitizeSvgMarkup, SPAN_STYLE_KEYS, type BogenDoc, type ComponentOptions, type ComponentProp, type NewNode, type PropValue, type TextSpan } from '@bogen/core';
import { imageSize } from './image-raster.ts';
import { fetchPublic } from './net-guard.ts';
import type { Storage } from './storage.ts';
import { errorMessage, HttpError } from './util.ts';

/**
 * Import from Figma through its public REST API, with the person's own personal access token.
 * https://developers.figma.com/docs/rest-api/ : `GET /v1/files/:key`, `GET /v1/images/:key` for vectors as
 * SVG, `GET /v1/files/:key/images` for image fills. It never reads the clipboard or `.fig` files.
 *
 * Fields used are the ones those pages and Figma's published OpenAPI types (github.com/figma/rest-api-spec)
 * document. The token goes to the API only, never to the download URLs it returns, and it is not stored here.
 */
export interface FigmaColor { r: number; g: number; b: number; a?: number }
export interface FigmaVector { x: number; y: number }
export interface FigmaImageFilters { exposure?: number; contrast?: number; saturation?: number; temperature?: number; tint?: number; highlights?: number; shadows?: number }
export interface FigmaPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaColor;
  blendMode?: string;
  gradientHandlePositions?: FigmaVector[];
  gradientStops?: { position: number; color: FigmaColor }[];
  scaleMode?: string;
  imageRef?: string;
  /** Only with `STRETCH`, which is how the API reports a crop: the layer's box in the image's unit square. */
  imageTransform?: number[][];
  scalingFactor?: number;
  filters?: FigmaImageFilters;
  rotation?: number;
}
export interface FigmaEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  color?: FigmaColor;
  offset?: FigmaVector;
  spread?: number;
}
export interface FigmaTypeStyle {
  fontFamily?: string;
  fontWeight?: number;
  fontSize?: number;
  italic?: boolean;
  letterSpacing?: number;
  lineHeightPx?: number;
  lineHeightPercentFontSize?: number;
  lineHeightUnit?: string;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textCase?: string;
  textDecoration?: string;
  textAutoResize?: string;
  textTruncation?: string;
  maxLines?: number | null;
  paragraphSpacing?: number;
  paragraphIndent?: number;
  fontVariantPosition?: string;
  fills?: FigmaPaint[];
  hyperlink?: { type?: string; url?: string; nodeID?: string };
}
export interface FigmaPath { path: string; windingRule?: string; overrideID?: number }
export interface FigmaComponentProperty { type: string; value?: PropValue; defaultValue?: PropValue; variantOptions?: string[] }
export interface FigmaNode {
  id: string;
  name?: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  size?: FigmaVector;
  relativeTransform?: number[][];
  constraints?: { horizontal?: string; vertical?: string };
  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  individualStrokeWeights?: { top: number; right: number; bottom: number; left: number };
  strokeAlign?: string;
  strokeDashes?: number[];
  strokesIncludedInLayout?: boolean;
  fillGeometry?: FigmaPath[];
  strokeGeometry?: FigmaPath[];
  arcData?: { startingAngle: number; endingAngle: number; innerRadius: number };
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  effects?: FigmaEffect[];
  blendMode?: string;
  opacity?: number;
  clipsContent?: boolean;
  isMask?: boolean;
  maskType?: string;
  layoutMode?: string;
  layoutWrap?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  counterAxisAlignContent?: string;
  counterAxisSpacing?: number;
  itemSpacing?: number;
  itemReverseZIndex?: boolean;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  layoutGrow?: number;
  layoutAlign?: string;
  layoutPositioning?: string;
  layoutSizingHorizontal?: string;
  layoutSizingVertical?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  minWidth?: number | null;
  maxWidth?: number | null;
  minHeight?: number | null;
  maxHeight?: number | null;
  gridColumnCount?: number;
  gridRowCount?: number;
  gridRowGap?: number;
  gridColumnGap?: number;
  gridColumnsSizing?: string;
  gridRowsSizing?: string;
  gridChildHorizontalAlign?: string;
  gridChildVerticalAlign?: string;
  gridRowSpan?: number;
  gridColumnSpan?: number;
  gridRowAnchorIndex?: number;
  gridColumnAnchorIndex?: number;
  characters?: string;
  style?: FigmaTypeStyle;
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, FigmaTypeStyle>;
  lineTypes?: string[];
  lineIndentations?: number[];
  /** INSTANCE: the component it shows. */
  componentId?: string;
  /** INSTANCE: values of its component's properties, by `Name#id` (a variant property by its plain name). */
  componentProperties?: Record<string, FigmaComponentProperty>;
  /** COMPONENT and COMPONENT_SET: the properties, by `Name#id`. */
  componentPropertyDefinitions?: Record<string, FigmaComponentProperty>;
  /** A layer in a component: which of its fields a property drives, such as `characters` or `visible`. */
  componentPropertyReferences?: Record<string, string>;
  overrides?: { id: string; overriddenFields: string[] }[];
}

interface FigmaComponentMeta { key?: string; name?: string; description?: string; componentSetId?: string; remote?: boolean }
export interface FigmaFile { name?: string; document?: FigmaNode; components?: Record<string, FigmaComponentMeta>; componentSets?: Record<string, FigmaComponentMeta> }

const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'REGULAR_POLYGON', 'LINE', 'WASHI_TAPE']);
const FRAME_TYPES = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION', 'TABLE', 'TABLE_CELL', 'TRANSFORM_GROUP']);
/** Parents whose children follow their constraints. A group's children are placed in the group's box. */
const CONSTRAINING = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION']);
const BLEND: Record<string, string> = {
  DARKEN: 'darken', MULTIPLY: 'multiply', COLOR_BURN: 'color-burn', LIGHTEN: 'lighten', SCREEN: 'screen', COLOR_DODGE: 'color-dodge', OVERLAY: 'overlay',
  SOFT_LIGHT: 'soft-light', HARD_LIGHT: 'hard-light', DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity',
  LINEAR_BURN: 'plus-darker', LINEAR_DODGE: 'plus-lighter',
};
const SPAN_KEYS = new Set<string>(SPAN_STYLE_KEYS);

export function parseFigmaUrl(raw: string): { key: string; nodeId?: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // A bare file key is fine too.
    if (/^[A-Za-z0-9]{10,}$/.test(raw)) return { key: raw };
    throw new HttpError(400, 'That is not a Figma file URL.');
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) throw new HttpError(400, 'That is not a Figma file URL.');
  const m = /^\/(?:file|design|proto|board)\/([A-Za-z0-9]+)/.exec(url.pathname);
  if (!m) throw new HttpError(400, 'That is not a Figma file URL.');
  const branch = /\/branch\/([A-Za-z0-9]+)/.exec(url.pathname)?.[1];
  const node = url.searchParams.get('node-id')?.replace('-', ':');
  return { key: branch ?? m[1]!, ...(node ? { nodeId: node } : {}) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function px(n: number): string {
  return `${round(n)}px`;
}

function pct(n: number): string {
  return `${round(n * 100)}%`;
}

function hex(color: FigmaColor): string {
  const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `#${[color.r, color.g, color.b].map((v) => to255(v).toString(16).padStart(2, '0')).join('')}`;
}

function rgba(color: FigmaColor, opacity = 1): string {
  const to255 = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);
  const alpha = round((color.a ?? 1) * opacity);
  if (alpha >= 1) return hex(color);
  return `rgba(${to255(color.r)}, ${to255(color.g)}, ${to255(color.b)}, ${alpha})`;
}

function visiblePaints(paints: FigmaPaint[] | undefined): FigmaPaint[] {
  return (paints ?? []).filter((p) => p.visible !== false);
}

export interface FigmaImportReport {
  file: string;
  pages: { pageId: string; name: string; layers: number }[];
  layers: number;
  images: number;
  vectors: number;
  /** Mains made into components, and instances linked to them. */
  components: number;
  instances: number;
  fonts: string[];
  /** What could not be brought over exactly, per kind, with an example layer. */
  unsupported: { what: string; count: number; example: string }[];
  failed: string[];
}

class Notes {
  private items = new Map<string, { count: number; example: string }>();

  add(what: string, node: FigmaNode): void {
    const item = this.items.get(what);
    if (item) item.count++;
    else this.items.set(what, { count: 1, example: node.name ?? node.id });
  }

  list(): FigmaImportReport['unsupported'] {
    return [...this.items.entries()].map(([what, v]) => ({ what, ...v })).sort((a, b) => (a.what < b.what ? -1 : 1));
  }
}

/** A main to mark once the layers are in the document: `createComponent` needs the stored layer. */
export interface FigmaMain { id: string; options: ComponentOptions }

interface Context {
  images: Map<string, string>;
  vectors: Map<string, string>;
  fonts: Set<string>;
  notes: Pick<Notes, 'add'>;
  /** Pixel sizes of image fills, by image ref, for tiles. */
  sizes?: Map<string, { width: number; height: number }>;
  /** The id each Figma layer gets here, made up front so that instances, props and overrides can point at them. */
  ids?: Map<string, string>;
  /** Every layer of the import, by Figma id, and its parent. */
  nodes?: Map<string, FigmaNode>;
  parents?: Map<string, FigmaNode | null>;
  /** Component metadata from the file: descriptions and sets. */
  meta?: Record<string, FigmaComponentMeta>;
  mains?: FigmaMain[];
  instances?: { count: number };
  /** Comparing an instance with its main: instances stay plain frames, and nothing is recorded. */
  flat?: boolean;
}

function idFor(ctx: Context, figmaId: string): string {
  ctx.ids ??= new Map();
  let id = ctx.ids.get(figmaId);
  if (!id) {
    id = newId();
    ctx.ids.set(figmaId, id);
  }
  return id;
}

/** A quiet copy for the comparisons of instances: what it notes or makes is thrown away. Fonts still count. */
function quiet(ctx: Context): Context {
  ctx.ids ??= new Map();
  return { ...ctx, notes: { add: () => {} }, mains: [], instances: { count: 0 }, flat: true };
}

/** A CSS gradient in the box of the given size, from the handles in normalized object space. */
function gradientCss(paint: FigmaPaint, width: number, height: number, ctx: Context, node: FigmaNode): string | null {
  const handles = paint.gradientHandlePositions ?? [];
  const stops = paint.gradientStops ?? [];
  const opacity = paint.opacity ?? 1;
  if (handles.length < 2 || !stops.length) return null;
  const at = (v: FigmaVector) => ({ x: v.x * width, y: v.y * height });
  const a = at(handles[0]!);
  const b = at(handles[1]!);
  if (paint.type === 'GRADIENT_LINEAR') {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const angle = Math.atan2(dx, -dy);
    // CSS measures stops along its own line through the centre, so each stop is projected onto that.
    const ux = Math.sin(angle);
    const uy = -Math.cos(angle);
    const length = Math.abs(width * ux) + Math.abs(height * uy) || 1;
    const css = stops.map((s) => {
      const x = a.x + dx * s.position - width / 2;
      const y = a.y + dy * s.position - height / 2;
      return `${rgba(s.color, opacity)} ${round(((x * ux + y * uy) / length + 0.5) * 100)}%`;
    });
    return `linear-gradient(${round((angle * 180) / Math.PI)}deg, ${css.join(', ')})`;
  }
  const list = stops.map((s) => `${rgba(s.color, opacity)} ${round(s.position * 100)}%`).join(', ');
  if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
    if (paint.type === 'GRADIENT_DIAMOND') ctx.notes.add('diamond gradients, made radial', node);
    const c = handles[2] ? at(handles[2]) : b;
    const rx = Math.hypot(b.x - a.x, b.y - a.y);
    const ry = Math.hypot(c.x - a.x, c.y - a.y) || rx;
    return `radial-gradient(ellipse ${px(rx)} ${px(ry)} at ${px(a.x)} ${px(a.y)}, ${list})`;
  }
  if (paint.type === 'GRADIENT_ANGULAR') {
    const from = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
    return `conic-gradient(from ${round(from)}deg at ${px(a.x)} ${px(a.y)}, ${list})`;
  }
  return null;
}

/**
 * The part of the image a crop shows, as fractions of the image. The API reports a crop as `STRETCH` with
 * `imageTransform`, whose scale and offset place the layer's box in the image's unit square.
 */
function cropOf(paint: FigmaPaint, ctx: Context, node: FigmaNode): { x: number; y: number; w: number; h: number } | null {
  const t = paint.imageTransform;
  if (!t || t.length < 2) return null;
  const [a = 1, b = 0, tx = 0] = t[0]!;
  const [c = 0, d = 1, ty = 0] = t[1]!;
  if (Math.abs(b) > 1e-4 || Math.abs(c) > 1e-4) ctx.notes.add('rotated image crops, cropped without the rotation', node);
  if (Math.abs(a - 1) < 1e-4 && Math.abs(d - 1) < 1e-4 && Math.abs(tx) < 1e-4 && Math.abs(ty) < 1e-4) return null;
  if (a > 1.0001 || d > 1.0001 || tx < -1e-4 || ty < -1e-4 || tx + a > 1.0001 || ty + d > 1.0001) ctx.notes.add('image crops reaching past the image, kept inside it', node);
  return { x: tx, y: ty, w: a, h: d };
}

/** CSS filters for Figma's image adjustments. Their curves are Figma's own, so these are close, not equal. */
function imageFilterCss(paint: FigmaPaint, ctx: Context, node: FigmaNode): string | null {
  const f = paint.filters;
  if (!f) return null;
  const out: string[] = [];
  if (f.exposure) out.push(`brightness(${round(2 ** f.exposure)})`);
  if (f.contrast) out.push(`contrast(${round(1 + f.contrast)})`);
  if (f.saturation) out.push(`saturate(${round(1 + f.saturation)})`);
  if (out.length) ctx.notes.add('image adjustments, approximated with CSS filters', node);
  if (f.temperature || f.tint || f.highlights || f.shadows) ctx.notes.add('image temperature, tint, highlights and shadows, left out', node);
  return out.length ? out.join(' ') : null;
}

/** Style for a stack of fills. Figma lists the bottom one first, CSS the top one. */
function fillStyle(node: FigmaNode, width: number, height: number, ctx: Context): Record<string, string> {
  const style: Record<string, string> = {};
  const paints = visiblePaints(node.fills);
  const layers: { image: string; size?: string; repeat?: string; position?: string }[] = [];
  paints.forEach((paint, i) => {
    if (paint.type === 'SOLID' && paint.color) {
      const color = rgba(paint.color, paint.opacity ?? 1);
      if (i === 0) style.backgroundColor = color;
      else layers.unshift({ image: `linear-gradient(${color}, ${color})` });
    } else if (paint.type.startsWith('GRADIENT_')) {
      const css = gradientCss(paint, width, height, ctx, node);
      if (css) layers.unshift({ image: css });
    } else if (paint.type === 'IMAGE' && paint.imageRef) {
      const src = ctx.images.get(paint.imageRef);
      if (!src) return;
      const mode = paint.scaleMode ?? 'FILL';
      if (paint.rotation && mode !== 'STRETCH') ctx.notes.add('rotated image fills, shown unrotated', node);
      if (paint.filters && Object.values(paint.filters).some(Boolean)) ctx.notes.add('image adjustments on a fill behind other layers, left out', node);
      if (paint.opacity !== undefined && paint.opacity < 1) ctx.notes.add('image fills with their own opacity, shown opaque', node);
      const url = `url("${src}")`;
      if (mode === 'TILE') {
        const natural = ctx.sizes?.get(paint.imageRef);
        const k = paint.scalingFactor ?? 1;
        if (!natural) ctx.notes.add('tiles of an image whose size is unknown, at its own size', node);
        layers.unshift({ image: url, repeat: 'repeat', position: '0 0', size: natural ? `${px(natural.width * k)} ${px(natural.height * k)}` : 'auto' });
        return;
      }
      const crop = mode === 'STRETCH' ? cropOf(paint, ctx, node) : null;
      if (crop) {
        const w = Math.min(1, Math.max(0.01, crop.w));
        const h = Math.min(1, Math.max(0.01, crop.h));
        const x = Math.min(1 - w, Math.max(0, crop.x));
        const y = Math.min(1 - h, Math.max(0, crop.y));
        layers.unshift({ image: url, repeat: 'no-repeat', size: `${pct(1 / w)} ${pct(1 / h)}`, position: `${pct(w >= 0.9999 ? 0 : x / (1 - w))} ${pct(h >= 0.9999 ? 0 : y / (1 - h))}` });
        return;
      }
      layers.unshift({ image: url, repeat: 'no-repeat', position: 'center', size: mode === 'FIT' ? 'contain' : mode === 'STRETCH' ? '100% 100%' : 'cover' });
    } else ctx.notes.add(`${paint.type.toLowerCase()} fills`, node);
    if (paint.blendMode && paint.blendMode !== 'NORMAL' && BLEND[paint.blendMode]) ctx.notes.add('blend modes on single fills', node);
  });
  if (layers.length) {
    style.backgroundImage = layers.map((l) => l.image).join(', ');
    if (layers.some((l) => l.size)) {
      style.backgroundSize = layers.map((l) => l.size ?? 'auto').join(', ');
      style.backgroundRepeat = layers.map((l) => l.repeat ?? 'no-repeat').join(', ');
      style.backgroundPosition = layers.map((l) => l.position ?? '0 0').join(', ');
    }
  }
  return style;
}

/** Shadows that draw a stroke on some sides only. Inset for inside, outside for outside, half each for centre. */
function sideShadows(weights: { top: number; right: number; bottom: number; left: number }, align: string, color: string): string[] {
  const dir = { top: [0, 1], right: [-1, 0], bottom: [0, -1], left: [1, 0] } as const;
  const inside: string[] = [];
  const outside: string[] = [];
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const w = weights[side];
    if (!w) continue;
    const [x, y] = dir[side];
    const inner = align === 'INSIDE' ? w : align === 'CENTER' ? w / 2 : 0;
    const outer = w - inner;
    if (inner) inside.push(`inset ${px(x * inner)} ${px(y * inner)} 0 0 ${color}`);
    if (outer) outside.push(`${px(-x * outer)} ${px(-y * outer)} 0 0 ${color}`);
  }
  return [...inside, ...outside];
}

function strokeStyle(node: FigmaNode, ctx: Context): { style: Record<string, string>; shadows: string[]; insets?: { top: number; right: number; bottom: number; left: number } } {
  const style: Record<string, string> = {};
  const shadows: string[] = [];
  const paints = visiblePaints(node.strokes);
  const weight = node.strokeWeight ?? 0;
  const paint = paints[0];
  if (!paint) return { style, shadows };
  if (paints.length > 1) ctx.notes.add('several strokes on one layer, first kept', node);
  if (paint.type !== 'SOLID' || !paint.color) {
    ctx.notes.add('gradient and image strokes, left out', node);
    return { style, shadows };
  }
  const color = rgba(paint.color, paint.opacity ?? 1);
  const each = node.individualStrokeWeights;
  const dashed = Boolean(node.strokeDashes?.length);
  const align = node.strokeAlign ?? 'INSIDE';
  if (each) {
    const seen = { top: each.top, right: each.right, bottom: each.bottom, left: each.left };
    // A border takes room, so it is right only where Figma counts the stroke in the layout, or for dashes.
    if (node.strokesIncludedInLayout || dashed) {
      for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        if (!seen[side]) continue;
        const name = side[0]!.toUpperCase() + side.slice(1);
        style[`border${name}`] = `${px(seen[side])} ${dashed ? 'dashed' : 'solid'} ${color}`;
      }
      return { style, shadows, insets: node.strokesIncludedInLayout ? undefined : seen };
    }
    return { style, shadows: sideShadows(seen, align, color) };
  }
  if (!weight) return { style, shadows };
  // Auto layout does not count a stroke unless told to, so a shadow or outline suits it better than a border.
  if (dashed) {
    style.outline = `${px(weight)} dashed ${color}`;
    style.outlineOffset = px(align === 'INSIDE' ? -weight : align === 'CENTER' ? -weight / 2 : 0);
  } else if (node.strokesIncludedInLayout) style.border = `${px(weight)} solid ${color}`;
  else if (align === 'OUTSIDE') shadows.push(`0 0 0 ${px(weight)} ${color}`);
  else if (align === 'CENTER') {
    style.outline = `${px(weight)} solid ${color}`;
    style.outlineOffset = px(-weight / 2);
  } else shadows.push(`inset 0 0 0 ${px(weight)} ${color}`);
  return { style, shadows };
}

/** A text stroke. CSS strokes the middle of the outline; drawn under the fill, twice as wide, it shows only outside. */
function textStrokeStyle(node: FigmaNode, ctx: Context): Record<string, string> {
  const paint = visiblePaints(node.strokes)[0];
  const weight = node.strokeWeight ?? 0;
  if (!paint || !weight) return {};
  if (paint.type !== 'SOLID' || !paint.color) {
    ctx.notes.add('gradient and image strokes, left out', node);
    return {};
  }
  const color = rgba(paint.color, paint.opacity ?? 1);
  const align = node.strokeAlign ?? 'OUTSIDE';
  if (align === 'OUTSIDE') return { WebkitTextStroke: `${px(weight * 2)} ${color}`, paintOrder: 'stroke fill' };
  if (align === 'INSIDE') ctx.notes.add('inside strokes on text, drawn centred', node);
  return { WebkitTextStroke: `${px(weight)} ${color}` };
}

function effectStyle(node: FigmaNode, ctx: Context, isText: boolean): { style: Record<string, string>; shadows: string[]; textShadows: string[] } {
  const style: Record<string, string> = {};
  const shadows: string[] = [];
  const textShadows: string[] = [];
  const filters: string[] = [];
  for (const effect of node.effects ?? []) {
    if (effect.visible === false) continue;
    const radius = effect.radius ?? 0;
    const color = effect.color ? rgba(effect.color) : 'rgba(0, 0, 0, 0.25)';
    const x = effect.offset?.x ?? 0;
    const y = effect.offset?.y ?? 0;
    if (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW') {
      if (isText) {
        if (effect.type === 'DROP_SHADOW') textShadows.push(`${px(x)} ${px(y)} ${px(radius)} ${color}`);
        else ctx.notes.add('inner shadows on text', node);
      } else shadows.push(`${effect.type === 'INNER_SHADOW' ? 'inset ' : ''}${px(x)} ${px(y)} ${px(radius)} ${px(effect.spread ?? 0)} ${color}`);
    } else if (effect.type === 'LAYER_BLUR') filters.push(`blur(${px(radius / 2)})`);
    else if (effect.type === 'BACKGROUND_BLUR') style.backdropFilter = `blur(${px(radius / 2)})`;
    else ctx.notes.add(`${effect.type.toLowerCase()} effects`, node);
  }
  if (filters.length) style.filter = filters.join(' ');
  return { style, shadows, textShadows };
}

function typeCss(type: FigmaTypeStyle, ctx: Context, node: FigmaNode): Record<string, string> {
  const style: Record<string, string> = {};
  if (type.fontFamily) {
    ctx.fonts.add(type.fontFamily);
    style.fontFamily = `"${type.fontFamily.replace(/["\\]/g, '')}", sans-serif`;
  }
  if (type.fontSize) style.fontSize = px(type.fontSize);
  if (type.fontWeight) style.fontWeight = String(type.fontWeight);
  if (type.italic) style.fontStyle = 'italic';
  if (type.letterSpacing) style.letterSpacing = px(type.letterSpacing);
  if (type.lineHeightUnit === 'INTRINSIC_%') style.lineHeight = 'normal';
  // A height set as a share of the size stays one when the size changes.
  else if (type.lineHeightUnit === 'FONT_SIZE_%' && type.lineHeightPercentFontSize) style.lineHeight = String(round(type.lineHeightPercentFontSize / 100));
  else if (type.lineHeightPx) style.lineHeight = px(type.lineHeightPx);
  const align = { LEFT: 'left', RIGHT: 'right', CENTER: 'center', JUSTIFIED: 'justify' }[type.textAlignHorizontal ?? ''];
  if (align) style.textAlign = align;
  if (type.textCase === 'UPPER') style.textTransform = 'uppercase';
  else if (type.textCase === 'LOWER') style.textTransform = 'lowercase';
  else if (type.textCase === 'TITLE') style.textTransform = 'capitalize';
  else if (type.textCase === 'SMALL_CAPS') style.fontVariantCaps = 'small-caps';
  else if (type.textCase === 'SMALL_CAPS_FORCED') style.fontVariantCaps = 'all-small-caps';
  if (type.textDecoration === 'UNDERLINE') style.textDecoration = 'underline';
  else if (type.textDecoration === 'STRIKETHROUGH') style.textDecoration = 'line-through';
  if (type.fontVariantPosition === 'SUPER') style.fontVariantPosition = 'super';
  else if (type.fontVariantPosition === 'SUB') style.fontVariantPosition = 'sub';
  const fill = visiblePaints(type.fills)[0];
  if (fill?.type === 'SOLID' && fill.color) style.color = rgba(fill.color, fill.opacity ?? 1);
  else if (fill?.type.startsWith('GRADIENT_')) {
    const css = gradientCss(fill, node.absoluteBoundingBox?.width ?? 100, node.absoluteBoundingBox?.height ?? 100, ctx, node);
    if (css) {
      style.backgroundImage = css;
      style.WebkitBackgroundClip = 'text';
      style.backgroundClip = 'text';
      style.color = 'transparent';
    }
  }
  return style;
}

const SPAN_NOTES: Record<string, string> = {
  lineHeight: 'line heights of text ranges, left out', textTransform: 'letter case of text ranges, left out', fontVariantCaps: 'letter case of text ranges, left out',
  backgroundImage: 'gradient fills of text ranges, left out', fontVariantPosition: 'superscript and subscript in text ranges, left out',
};

/** Style overrides as ranges. Figma says per character which override applies, where zero is none. */
function textSpans(node: FigmaNode, ctx: Context): TextSpan[] {
  const overrides = node.characterStyleOverrides ?? [];
  const table = node.styleOverrideTable ?? {};
  const spans: TextSpan[] = [];
  let start = 0;
  const push = (id: number, end: number) => {
    if (!id) return;
    const type = table[String(id)];
    if (!type) return;
    const css = typeCss(type, ctx, node);
    // A range only keeps the longhand, as rich text allows no shorthands.
    if (css.textDecoration) {
      css.textDecorationLine = css.textDecoration;
      delete css.textDecoration;
    }
    const style: Record<string, string> = {};
    for (const [key, value] of Object.entries(css)) {
      if (SPAN_KEYS.has(key)) style[key] = value;
      else if (SPAN_NOTES[key]) ctx.notes.add(SPAN_NOTES[key], node);
    }
    if (type.hyperlink?.type === 'NODE') ctx.notes.add('links to layers inside text, left out', node);
    const href = type.hyperlink?.type === 'URL' ? type.hyperlink.url : undefined;
    if (Object.keys(style).length || href) spans.push({ start, end, ...(Object.keys(style).length ? { style } : {}), ...(href ? { href } : {}) });
  };
  for (let i = 1; i <= overrides.length; i++) {
    if (i === overrides.length || overrides[i] !== overrides[start]) {
      push(overrides[start]!, i);
      start = i;
    }
  }
  return spans;
}

/** Lists as their markers in the words: a bullet, or the item's number. Ranges move along with what goes in. */
function withListMarkers(node: FigmaNode, text: string, spans: TextSpan[], ctx: Context): { text: string; spans: TextSpan[] } {
  const types = node.lineTypes ?? [];
  if (!types.some((t) => t === 'ORDERED' || t === 'UNORDERED')) return { text, spans };
  ctx.notes.add('lists, written as marker characters', node);
  const lines = text.split(/(?<=[\n\u2029])/);
  const inserts: { at: number; length: number }[] = [];
  let out = '';
  let at = 0;
  const counters = new Map<number, number>();
  lines.forEach((line, i) => {
    const kind = types[i] ?? 'NONE';
    const level = node.lineIndentations?.[i] ?? 1;
    if (level > 1) ctx.notes.add('indentation of nested list items, left out', node);
    let marker = '';
    if (kind === 'UNORDERED') marker = '\u2022 ';
    else if (kind === 'ORDERED') {
      const n = (counters.get(level) ?? 0) + 1;
      counters.set(level, n);
      marker = `${n}. `;
    }
    if (kind !== 'ORDERED') counters.delete(level);
    if (marker) inserts.push({ at, length: marker.length });
    out += marker + line;
    at += line.length;
  });
  const shift = (pos: number, inclusive: boolean) => pos + inserts.filter((x) => (inclusive ? x.at <= pos : x.at < pos)).reduce((s, x) => s + x.length, 0);
  return { text: out, spans: spans.map((s) => ({ ...s, start: shift(s.start, true), end: shift(s.end, false) })) };
}

function layoutOf(node: FigmaNode): 'row' | 'column' | 'grid' | null {
  if (node.layoutMode === 'HORIZONTAL') return 'row';
  if (node.layoutMode === 'VERTICAL') return 'column';
  if (node.layoutMode === 'GRID') return 'grid';
  return null;
}

function boxOf(node: FigmaNode): { x: number; y: number; width: number; height: number } {
  const b = node.absoluteBoundingBox;
  const width = node.size?.x ?? b?.width ?? 0;
  const height = node.size?.y ?? b?.height ?? 0;
  return { x: b?.x ?? 0, y: b?.y ?? 0, width, height };
}

const SELF_ALIGN: Record<string, string> = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end' };
const GRID_ALIGN: Record<string, string> = { MIN: 'start', CENTER: 'center', MAX: 'end' };

/** One axis of an absolutely placed layer, from its constraint: which sides it keeps, or a share of the parent. */
function constrained(style: Record<string, string>, constraint: string, start: number, size: number, parentSize: number, sides: ['left', 'right', 'width'] | ['top', 'bottom', 'height']): void {
  const [near, far, length] = sides;
  const end = parentSize - start - size;
  if (constraint === 'RIGHT' || constraint === 'BOTTOM') {
    style[far] = px(end);
    style[length] = px(size);
  } else if (constraint === 'LEFT_RIGHT' || constraint === 'TOP_BOTTOM') {
    style[near] = px(start);
    style[far] = px(end);
  } else if (constraint === 'CENTER') {
    const offset = start - parentSize / 2;
    style[near] = `calc(50% ${offset < 0 ? '-' : '+'} ${px(Math.abs(offset))})`;
    style[length] = px(size);
  } else if (constraint === 'SCALE' && parentSize > 0) {
    style[near] = pct(start / parentSize);
    style[length] = pct(size / parentSize);
  } else {
    style[near] = px(start);
    style[length] = px(size);
  }
}

/** Where a layer goes in its parent, and how big it is. */
function placeStyle(node: FigmaNode, parent: FigmaNode | null): Record<string, string> {
  const style: Record<string, string> = {};
  const box = boxOf(node);
  const parentLayout = parent ? layoutOf(parent) : null;
  const flowing = parentLayout && node.layoutPositioning !== 'ABSOLUTE';
  const transform = node.relativeTransform;
  const rotated = transform && (Math.abs(transform[0]![0]! - 1) > 1e-4 || Math.abs(transform[0]![1]!) > 1e-4 || Math.abs(transform[1]![0]!) > 1e-4 || Math.abs(transform[1]![1]! - 1) > 1e-4);
  if (flowing && parentLayout === 'grid') {
    style.position = 'relative';
    const h = node.layoutSizingHorizontal;
    const v = node.layoutSizingVertical;
    if (h === 'FILL') style.justifySelf = 'stretch';
    else {
      if (h !== 'HUG') style.width = px(box.width);
      const a = GRID_ALIGN[node.gridChildHorizontalAlign ?? ''];
      if (a) style.justifySelf = a;
    }
    if (v === 'FILL') style.alignSelf = 'stretch';
    else {
      if (v !== 'HUG') style.height = px(box.height);
      const a = GRID_ALIGN[node.gridChildVerticalAlign ?? ''];
      if (a) style.alignSelf = a;
    }
    const track = (anchor: number | undefined, span: number | undefined) => (anchor !== undefined && anchor >= 0 ? `${Math.round(anchor) + 1} / span ${Math.max(1, Math.round(span ?? 1))}` : span && span > 1 ? `span ${Math.round(span)}` : null);
    const column = track(node.gridColumnAnchorIndex, node.gridColumnSpan);
    const row = track(node.gridRowAnchorIndex, node.gridRowSpan);
    if (column) style.gridColumn = column;
    if (row) style.gridRow = row;
  } else if (flowing && parent) {
    style.position = 'relative';
    const row = parentLayout === 'row';
    const sizing = (axis: 'h' | 'v') => (axis === 'h' ? node.layoutSizingHorizontal : node.layoutSizingVertical);
    const main = row ? 'h' : 'v';
    const cross = row ? 'v' : 'h';
    const fills = (axis: 'h' | 'v') => sizing(axis) === 'FILL' || (axis === main ? node.layoutGrow === 1 : node.layoutAlign === 'STRETCH');
    if (fills(main)) {
      style.flex = '1 1 0';
      style[row ? 'minWidth' : 'minHeight'] = '0';
    } else if (sizing(main) !== 'HUG') style[row ? 'width' : 'height'] = px(row ? box.width : box.height);
    if (fills(cross)) style.alignSelf = 'stretch';
    else {
      if (sizing(cross) !== 'HUG') style[row ? 'height' : 'width'] = px(row ? box.height : box.width);
      // Older files align a child on its own instead of through the frame.
      const own = SELF_ALIGN[node.layoutAlign ?? ''];
      if (own) style.alignSelf = own;
    }
    style.flexShrink = fills(main) ? '1' : '0';
  } else {
    const parentBox = parent ? boxOf(parent) : { x: 0, y: 0, width: 0, height: 0 };
    const b = node.absoluteBoundingBox ?? { x: 0, y: 0, width: box.width, height: box.height };
    style.position = 'absolute';
    // The box is the rotated layer's bounds, and its middle is the same with or without the rotation.
    const left = b.x + b.width / 2 - box.width / 2 - parentBox.x;
    const top = b.y + b.height / 2 - box.height / 2 - parentBox.y;
    const c = parent && CONSTRAINING.has(parent.type) ? node.constraints : undefined;
    constrained(style, c?.horizontal ?? 'LEFT', left, box.width, parentBox.width, ['left', 'right', 'width']);
    constrained(style, c?.vertical ?? 'TOP', top, box.height, parentBox.height, ['top', 'bottom', 'height']);
  }
  if (rotated) {
    const [a, c] = transform![0]!;
    const [b, d] = transform![1]!;
    style.transform = `matrix(${[a, b, c, d].map((v) => round(v!)).join(', ')}, 0, 0)`;
  }
  for (const [key, css] of [['minWidth', 'minWidth'], ['maxWidth', 'maxWidth'], ['minHeight', 'minHeight'], ['maxHeight', 'maxHeight']] as const) {
    const value = node[key];
    if (typeof value === 'number') style[css] = px(value);
  }
  return style;
}

/** Grid tracks as Figma gives them, when they are plain CSS track lists. */
const TRACKS = /^[\w\s().,%-]{1,200}$/;

function autoLayoutStyle(node: FigmaNode): Record<string, string> {
  const layout = layoutOf(node);
  if (!layout) return {};
  const style: Record<string, string> = {};
  if (layout === 'grid') {
    style.display = 'grid';
    if (node.gridColumnsSizing && TRACKS.test(node.gridColumnsSizing)) style.gridTemplateColumns = node.gridColumnsSizing;
    else if (node.gridColumnCount) style.gridTemplateColumns = `repeat(${Math.round(node.gridColumnCount)}, minmax(0, 1fr))`;
    if (node.gridRowsSizing && TRACKS.test(node.gridRowsSizing)) style.gridTemplateRows = node.gridRowsSizing;
    else if (node.gridRowCount) style.gridTemplateRows = `repeat(${Math.round(node.gridRowCount)}, minmax(0, auto))`;
    if (node.gridRowGap !== undefined || node.gridColumnGap !== undefined) {
      if (node.gridRowGap) style.rowGap = px(node.gridRowGap);
      if (node.gridColumnGap) style.columnGap = px(node.gridColumnGap);
    } else if ((node.itemSpacing ?? 0) > 0) style.rowGap = px(node.itemSpacing!);
  } else {
    style.display = 'flex';
    style.flexDirection = layout;
    const main = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', SPACE_BETWEEN: 'space-between' }[node.primaryAxisAlignItems ?? 'MIN'];
    const cross = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'baseline' }[node.counterAxisAlignItems ?? 'MIN'];
    if (main) style.justifyContent = main;
    if (cross) style.alignItems = cross;
    if (node.layoutWrap === 'WRAP') {
      style.flexWrap = 'wrap';
      // Figma packs wrapped lines together; CSS would stretch them over the frame unless told.
      if (node.counterAxisAlignContent === 'SPACE_BETWEEN') style.alignContent = 'space-between';
      else style.alignContent = { MIN: 'flex-start', CENTER: 'center', MAX: 'flex-end', BASELINE: 'flex-start' }[node.counterAxisAlignItems ?? 'MIN'] ?? 'flex-start';
    }
    const spacing = node.itemSpacing ?? 0;
    // A negative spacing overlaps the children: a gap cannot, so the children get negative margins instead.
    if (spacing > 0 && node.primaryAxisAlignItems !== 'SPACE_BETWEEN') style[layout === 'row' ? 'columnGap' : 'rowGap'] = px(spacing);
    if (node.counterAxisSpacing) style[layout === 'row' ? 'rowGap' : 'columnGap'] = px(node.counterAxisSpacing);
  }
  const padding = [node.paddingTop ?? 0, node.paddingRight ?? 0, node.paddingBottom ?? 0, node.paddingLeft ?? 0];
  if (padding.some(Boolean)) style.padding = padding.map(px).join(' ');
  return style;
}

function radiusStyle(node: FigmaNode): Record<string, string> {
  if (node.rectangleCornerRadii?.some(Boolean)) return { borderRadius: node.rectangleCornerRadii.map(px).join(' ') };
  return node.cornerRadius ? { borderRadius: px(node.cornerRadius) } : {};
}

function commonStyle(node: FigmaNode): Record<string, string> {
  const style: Record<string, string> = {};
  if (node.opacity !== undefined && node.opacity < 1) style.opacity = String(round(node.opacity));
  const blend = node.blendMode ? BLEND[node.blendMode] : undefined;
  if (blend) style.mixBlendMode = blend;
  return style;
}

const PATH_DATA = /^[MLHVCSQTAZmlhvcsqtaz0-9.,\seE+-]{1,200000}$/;
const xmlAttr = (s: string) => s.replace(/[<>&"]/g, '');

/** Paint of one SVG path: a colour, or a gradient written into `defs`. */
function svgPaint(paint: FigmaPaint, width: number, height: number, defs: string[], idBase: string): string | null {
  const opacity = paint.opacity ?? 1;
  if (paint.type === 'SOLID' && paint.color) {
    const alpha = round((paint.color.a ?? 1) * opacity);
    return `fill="${hex(paint.color)}"${alpha < 1 ? ` fill-opacity="${alpha}"` : ''}`;
  }
  const handles = paint.gradientHandlePositions ?? [];
  const stops = (paint.gradientStops ?? []).map((s) => `<stop offset="${round(s.position)}" stop-color="${hex(s.color)}"${round((s.color.a ?? 1) * opacity) < 1 ? ` stop-opacity="${round((s.color.a ?? 1) * opacity)}"` : ''}/>`).join('');
  if (handles.length < 2 || !stops) return null;
  const [a, b] = [handles[0]!, handles[1]!].map((v) => ({ x: round(v.x * width), y: round(v.y * height) })) as [FigmaVector, FigmaVector];
  const id = `${idBase}-g${defs.length}`;
  if (paint.type === 'GRADIENT_LINEAR') defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}">${stops}</linearGradient>`);
  else if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${a.x}" cy="${a.y}" r="${round(Math.hypot(b.x - a.x, b.y - a.y))}">${stops}</radialGradient>`);
  else return null;
  return `fill="url(#${id})"`;
}

/**
 * A vector drawn from the geometry the file itself carries (`geometry=paths`), for when the SVG render is
 * missing: fill paths in the fills, stroke outlines in the stroke's paint, in the layer's own box.
 */
export function geometrySvg(node: FigmaNode, idBase: string, ctx: Context): string | null {
  const fillPaths = (node.fillGeometry ?? []).filter((p) => PATH_DATA.test(p.path));
  const strokePaths = (node.strokeGeometry ?? []).filter((p) => PATH_DATA.test(p.path));
  if (!fillPaths.length && !strokePaths.length) return null;
  const { width, height } = boxOf(node);
  const defs: string[] = [];
  const body: string[] = [];
  const draw = (paths: FigmaPath[], paints: FigmaPaint[]) => {
    for (const paint of paints) {
      const attr = svgPaint(paint, width, height, defs, idBase);
      if (!attr) {
        ctx.notes.add(`${paint.type.toLowerCase()} paints on vectors drawn from geometry, left out`, node);
        continue;
      }
      for (const p of paths) body.push(`<path d="${xmlAttr(p.path)}"${p.windingRule === 'EVENODD' ? ' fill-rule="evenodd"' : ''} ${attr}/>`);
    }
  };
  draw(fillPaths, visiblePaints(node.fills));
  draw(strokePaths, visiblePaints(node.strokes));
  if (!body.length) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${round(Math.max(width, 0.01))}" height="${round(Math.max(height, 0.01))}" viewBox="0 0 ${round(Math.max(width, 0.01))} ${round(Math.max(height, 0.01))}" fill="none" overflow="visible">${defs.length ? `<defs>${defs.join('')}</defs>` : ''}${body.join('')}</svg>`;
  return sanitizeSvgMarkup(svg) || null;
}

/** An ellipse that is an arc, a pie or a ring: drawn as a vector, as CSS cannot. */
function isArc(node: FigmaNode): boolean {
  const arc = node.arcData;
  if (node.type !== 'ELLIPSE' || !arc) return false;
  return arc.innerRadius > 1e-4 || Math.abs(Math.abs(arc.endingAngle - arc.startingAngle) - 2 * Math.PI) > 1e-3;
}

/** A Figma property name as a prop name here: `Has icon#12:0` becomes `hasIcon`. */
export function propName(key: string): string {
  const words = key.replace(/#[^#]*$/, '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  const name = words.map((w, i) => (i === 0 ? w[0]!.toLowerCase() + w.slice(1) : w[0]!.toUpperCase() + w.slice(1))).join('');
  return /^[A-Za-z_]/.test(name) ? name : `p${name || 'rop'}`;
}

/** `Size=Large, State=Hover` as variant values. */
function variantOf(name: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const part of name.split(',')) {
    const at = part.indexOf('=');
    if (at < 1) return null;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The Figma ids that make a layer's path in its main. A layer inside an instance has the id
 * `I<instance>;<layer in the component>`, and one in a nested instance `I<instance>;<nested>;<layer>`.
 */
function pathIds(figmaId: string, root?: string): string[] | null {
  if (root !== undefined) {
    const prefix = `${root.startsWith('I') ? root : `I${root}`};`;
    return figmaId.startsWith(prefix) ? figmaId.slice(prefix.length).split(';') : null;
  }
  return figmaId.startsWith('I') ? figmaId.slice(1).split(';') : [figmaId];
}

/** A main's text and boolean properties, each driving the layers whose references name it. */
function mainProps(main: FigmaNode, defs: Record<string, FigmaComponentProperty> | undefined, ctx: Context): ComponentProp[] {
  if (!defs) return [];
  const props: ComponentProp[] = [];
  const used = new Set<string>();
  for (const [key, def] of Object.entries(defs)) {
    if (def.type !== 'TEXT' && def.type !== 'BOOLEAN') {
      if (def.type === 'INSTANCE_SWAP') ctx.notes.add('instance swap properties, kept as each instance\'s own swap', main);
      else if (def.type === 'SLOT') ctx.notes.add('slot properties, left out', main);
      continue;
    }
    let name = propName(key);
    while (used.has(name)) name += '_';
    used.add(name);
    const targets: { path: string; field: string }[] = [];
    const visit = (n: FigmaNode) => {
      const refs = n.componentPropertyReferences ?? {};
      if (def.type === 'TEXT' && refs.characters === key) targets.push({ path: idFor(ctx, n.id), field: 'text' });
      if (def.type === 'BOOLEAN' && refs.visible === key) targets.push({ path: idFor(ctx, n.id), field: 'visible' });
      // Layers inside a nested instance belong to that instance's own properties.
      if (n.type !== 'INSTANCE') n.children?.forEach(visit);
    };
    main.children?.forEach(visit);
    const value = def.defaultValue;
    props.push({ name, type: def.type === 'TEXT' ? 'text' : 'boolean', ...(value !== undefined ? { default: def.type === 'TEXT' ? String(value) : Boolean(value) } : {}), targets });
  }
  return props;
}

/** Props of an instance, from the values Figma gives it. Variant values pick the main instead. */
function instanceProps(node: FigmaNode): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  for (const [key, prop] of Object.entries(node.componentProperties ?? {})) {
    if ((prop.type === 'TEXT' || prop.type === 'BOOLEAN') && prop.value !== undefined) out[propName(key)] = prop.type === 'TEXT' ? String(prop.value) : Boolean(prop.value);
  }
  return out;
}

type PathIndex = Map<string, { spec: NewNode; figma: FigmaNode }>;

/**
 * The layers of a converted tree by their path in the main, as `overrides` keys name them. For an instance,
 * `root` is its id, and a layer whose id does not say where it comes from takes the path of the main's layer
 * in the same place, `mirror`.
 */
function indexByPath(spec: NewNode, figma: FigmaNode, ctx: Context, out: PathIndex, options: { base?: string; root?: string; mirror?: FigmaNode } = {}): void {
  const kids = (figma.children ?? []).filter((c) => c.type !== 'SLICE');
  const mirrors = (options.mirror?.children ?? []).filter((c) => c.type !== 'SLICE');
  const specs = spec.children ?? [];
  // Converted children keep the order of the Figma ones that made something.
  let j = 0;
  kids.forEach((child, k) => {
    const childSpec = specs[j];
    if (!childSpec || childSpec.name !== (child.name || child.type.toLowerCase())) return;
    j++;
    const mirror = mirrors[k];
    const ids = options.root !== undefined ? pathIds(child.id, options.root) ?? (mirror ? pathIds(mirror.id) : null) : pathIds(child.id);
    if (!ids) return;
    const path = [...(options.base ? [options.base] : []), ...ids.map((i) => idFor(ctx, i))].join('/');
    out.set(path, { spec: childSpec, figma: child });
    indexByPath(childSpec, child, ctx, out, { ...options, mirror });
  });
}

/** Override keys that make the main's tree look like the instance's, field by field. */
function diffOverrides(own: PathIndex, main: PathIndex, ctx: Context, node: FigmaNode): Record<string, PropValue> {
  const out: Record<string, PropValue> = {};
  let unmatched = 0;
  // Nested instances swapped for another component, compared with that component instead.
  const swapped = new Map<string, FigmaNode>();
  for (const [path, mine] of own) {
    const theirs = main.get(path);
    if (!theirs) {
      if (![...swapped.keys()].some((p) => path.startsWith(`${p}/`))) unmatched++;
      continue;
    }
    const refs = theirs.figma.componentPropertyReferences ?? {};
    if (mine.figma.type === 'INSTANCE' && theirs.figma.type === 'INSTANCE') {
      if (mine.figma.componentId && mine.figma.componentId !== theirs.figma.componentId) {
        const target = ctx.nodes?.get(mine.figma.componentId);
        if (target?.type === 'COMPONENT') {
          out[`${path}#instanceOf`] = idFor(ctx, target.id);
          swapped.set(path, target);
        } else ctx.notes.add('swaps to components not in the import, left out', node);
      }
      const props = instanceProps(mine.figma);
      const before = instanceProps(theirs.figma);
      for (const [k, v] of Object.entries(props)) if (before[k] !== v) out[`${path}#prop.${k}`] = v;
    }
    const a = mine.spec;
    const b = theirs.spec;
    for (const key of new Set([...Object.keys(a.style ?? {}), ...Object.keys(b.style ?? {})])) {
      const va = a.style?.[key];
      if (va !== b.style?.[key]) out[`${path}#style.${key}`] = va ?? '';
    }
    if (a.text !== b.text && !refs.characters) out[`${path}#text`] = a.text ?? '';
    if (JSON.stringify(a.spans ?? []) !== JSON.stringify(b.spans ?? []) && (a.spans?.length || a.text === b.text)) ctx.notes.add('text ranges changed inside instances, left out', node);
    if (Boolean(a.hidden) !== Boolean(b.hidden) && !refs.visible) out[`${path}#hidden`] = Boolean(a.hidden);
    if (a.src !== b.src && a.src !== undefined) out[`${path}#src`] = a.src;
    if (a.svg !== b.svg && a.svg !== undefined) out[`${path}#svg`] = a.svg;
  }
  // What sits under a swapped instance compares with the component it was swapped to.
  for (const [path, target] of swapped) {
    const theirs: PathIndex = new Map();
    const spec = convertNode(target, ctx.parents?.get(target.id) ?? null, quiet(ctx));
    if (spec) indexByPath(spec, target, ctx, theirs, { base: path });
    const mine = new Map([...own].filter(([p]) => p.startsWith(`${path}/`)));
    Object.assign(out, diffOverrides(mine, theirs, ctx, node));
  }
  if (unmatched) ctx.notes.add('layers of instances that are not in their main, left out', node);
  return out;
}

const OWN_ONLY = new Set(['position', 'left', 'top', 'right', 'bottom']);

function linkedMain(node: FigmaNode, ctx: Context): FigmaNode | undefined {
  if (node.type !== 'INSTANCE' || ctx.flat || !node.componentId) return undefined;
  const main = ctx.nodes?.get(node.componentId);
  return main?.type === 'COMPONENT' ? main : undefined;
}

/** An instance linked to its main, with its own look and the overrides that make it look as in Figma. */
function instanceNode(node: FigmaNode, main: FigmaNode, ctx: Context, plain: NewNode): NewNode {
  const q = quiet(ctx);
  const mainSpec = convertNode(main, ctx.parents?.get(main.id) ?? null, q);
  if (!mainSpec) return plain;
  const style: Record<string, string> = {};
  for (const key of new Set([...Object.keys(plain.style ?? {}), ...Object.keys(mainSpec.style ?? {})])) {
    const mine = plain.style?.[key];
    if (OWN_ONLY.has(key)) {
      if (mine !== undefined) style[key] = mine;
    } else if (mine !== mainSpec.style?.[key]) style[key] = mine ?? '';
  }
  const own: PathIndex = new Map();
  const theirs: PathIndex = new Map();
  indexByPath(plain, node, ctx, own, { root: node.id, mirror: main });
  indexByPath(mainSpec, main, ctx, theirs);
  const overrides = diffOverrides(own, theirs, ctx, node);
  const props = instanceProps(node);
  if (ctx.instances) ctx.instances.count++;
  return {
    type: 'frame', tag: mainSpec.tag ?? 'div', name: plain.name, fixedId: plain.fixedId, instanceOf: idFor(ctx, main.id), style,
    ...(plain.hidden ? { hidden: true } : {}),
    ...(Object.keys(props).length ? { props } : {}),
    ...(Object.keys(overrides).length ? { overrides } : {}),
  };
}

/**
 * Layers under a mask: Figma masks the siblings above it. A rectangle, ellipse or frame mask becomes a
 * clipping frame in its place, which holds those siblings; other masks stay plain layers.
 */
function convertChildren(node: FigmaNode, ctx: Context): NewNode[] {
  const kids = node.children ?? [];
  const out: NewNode[] = [];
  const auto = layoutOf(node) !== null;
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i]!;
    const shape = child.type === 'RECTANGLE' || child.type === 'ELLIPSE' || child.type === 'FRAME';
    const transform = child.relativeTransform;
    const straight = !transform || (Math.abs(transform[0]![1]!) < 1e-4 && Math.abs(transform[1]![0]!) < 1e-4);
    if (child.isMask && shape && straight && !auto && child.visible !== false) {
      const masked = kids.slice(i + 1);
      if (child.maskType === 'LUMINANCE') ctx.notes.add('luminance masks, clipped to their shape', child);
      // The masked layers are placed in the mask's box, as if it were their frame.
      const frame: FigmaNode = { ...child, type: 'GROUP', children: masked, constraints: undefined };
      // A mask shape draws nothing itself: it keeps its place, size and corners, and clips.
      const place = { ...placeStyle(child, node), ...radiusStyle(child), ...(child.type === 'ELLIPSE' ? { borderRadius: '50%' } : {}) };
      const inner = masked.flatMap((m) => convertNode(m, frame, ctx) ?? []);
      out.push({ type: 'frame', tag: 'div', name: child.name || 'Mask', fixedId: idFor(ctx, child.id), style: { ...place, overflow: 'hidden' }, ...(inner.length ? { children: inner } : {}) });
      break;
    }
    if (child.isMask) ctx.notes.add('masks that are not a plain rectangle, ellipse or frame outside auto layout, left as plain layers', child);
    const spec = convertNode(child, node, ctx);
    if (spec) out.push(spec);
  }
  return out;
}

export function convertNode(node: FigmaNode, parent: FigmaNode | null, ctx: Context): NewNode | null {
  if (node.type === 'SLICE') return null;
  const hidden = node.visible === false ? { hidden: true } : {};
  const name = node.name || node.type.toLowerCase();
  const fixedId = idFor(ctx, node.id);
  const base = { ...placeStyle(node, parent), ...commonStyle(node) };
  const box = boxOf(node);
  if (node.isMask && parent === null) ctx.notes.add('masks that are not a plain rectangle, ellipse or frame outside auto layout, left as plain layers', node);

  if (VECTOR_TYPES.has(node.type) || (node.type === 'ELLIPSE' && (ctx.vectors.has(node.id) || isArc(node)))) {
    const svg = ctx.vectors.get(node.id) ?? geometrySvg(node, `f${fixedId}`, ctx);
    if (svg) {
      if (!ctx.vectors.has(node.id)) ctx.notes.add('vectors drawn from their paths, without effects', node);
      return { type: 'svg', name, tag: 'span', fixedId, style: base, svg, ...hidden };
    }
    ctx.notes.add('vectors without a render, left out', node);
    return null;
  }

  if (node.type === 'TEXT') {
    const type = node.style ?? {};
    const style: Record<string, string> = { ...base, ...typeCss({ fills: node.fills, ...type }, ctx, node), ...textStrokeStyle(node, ctx) };
    const resize = type.textAutoResize;
    if (resize === 'WIDTH_AND_HEIGHT') {
      style.whiteSpace = 'pre';
      delete style.width;
      delete style.height;
    } else if (resize === 'HEIGHT' || !resize) {
      style.whiteSpace = 'pre-wrap';
      delete style.height;
    } else style.whiteSpace = 'pre-wrap';
    if (type.textTruncation === 'ENDING') {
      style.overflow = 'hidden';
      style.textOverflow = 'ellipsis';
      if (type.maxLines) {
        style.display = '-webkit-box';
        style.WebkitBoxOrient = 'vertical';
        style.WebkitLineClamp = String(type.maxLines);
      }
    }
    if ((type.textAlignVertical === 'CENTER' || type.textAlignVertical === 'BOTTOM') && style.height) {
      style.display = 'flex';
      style.flexDirection = 'column';
      style.justifyContent = type.textAlignVertical === 'CENTER' ? 'center' : 'flex-end';
    }
    const paragraphs = (node.characters ?? '').split(/[\n\u2029]/).length;
    if (type.paragraphIndent) {
      style.textIndent = px(type.paragraphIndent);
      if (paragraphs > 1) ctx.notes.add('paragraph indents after the first paragraph, left out', node);
    }
    if (type.paragraphSpacing && paragraphs > 1) ctx.notes.add('spacing between paragraphs, left out', node);
    const effects = effectStyle(node, ctx, true);
    Object.assign(style, effects.style);
    if (effects.textShadows.length) style.textShadow = effects.textShadows.join(', ');
    const link = type.hyperlink?.type === 'URL' ? type.hyperlink.url : undefined;
    if (type.hyperlink?.type === 'NODE') ctx.notes.add('links to layers inside text, left out', node);
    const listed = withListMarkers(node, node.characters ?? '', textSpans(node, ctx), ctx);
    const spans = link ? [...listed.spans, { start: 0, end: listed.text.length, href: link }] : listed.spans;
    return { type: 'text', name, tag: 'p', fixedId, style, text: listed.text, ...hidden, ...(spans.length ? { spans } : {}) };
  }

  const fills = visiblePaints(node.fills);
  const effects = effectStyle(node, ctx, false);
  const stroke = strokeStyle(node, ctx);
  const shadows = [...stroke.shadows, ...effects.shadows];
  const paint: Record<string, string> = {
    ...radiusStyle(node), ...effects.style, ...stroke.style,
    ...(shadows.length ? { boxShadow: shadows.join(', ') } : {}),
  };

  // A rectangle with just a picture is an image layer, which edits as one.
  const only = fills.length === 1 ? fills[0]! : null;
  if (node.type === 'RECTANGLE' && only?.type === 'IMAGE' && only.imageRef && ctx.images.get(only.imageRef) && only.scaleMode !== 'TILE') {
    if ((only.opacity ?? 1) < 1) paint.opacity = String(round((only.opacity ?? 1) * (node.opacity ?? 1)));
    const crop = only.scaleMode === 'STRETCH' ? cropOf(only, ctx, node) : null;
    const filter = imageFilterCss(only, ctx, node);
    if (filter) paint.filter = paint.filter ? `${filter} ${paint.filter}` : filter;
    if (only.rotation) ctx.notes.add('rotated image fills, shown unrotated', node);
    return {
      type: 'image', name, tag: 'img', fixedId, src: ctx.images.get(only.imageRef), ...hidden,
      ...(crop ? { attrs: { [CROP_ATTR]: formatCrop(crop) } } : {}),
      style: { ...base, ...paint, ...(crop ? {} : { objectFit: only.scaleMode === 'FIT' ? 'contain' : only.scaleMode === 'STRETCH' ? 'fill' : 'cover' }) },
    };
  }

  if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') {
    return {
      type: 'frame', name, tag: 'div', fixedId, ...hidden,
      style: { ...base, ...fillStyle(node, box.width, box.height, ctx), ...paint, ...(node.type === 'ELLIPSE' ? { borderRadius: '50%' } : {}) },
    };
  }

  if (FRAME_TYPES.has(node.type)) {
    const auto = autoLayoutStyle(node);
    if (stroke.insets && auto.padding) {
      const [t, r, b, l] = auto.padding.split(' ').map(parseFloat) as [number, number, number, number];
      auto.padding = [t - stroke.insets.top, r - stroke.insets.right, b - stroke.insets.bottom, l - stroke.insets.left].map((v) => px(Math.max(0, v))).join(' ');
    }
    const clips = node.clipsContent || node.type === 'SECTION';
    const style: Record<string, string> = {
      ...base, ...auto, ...fillStyle(node, box.width, box.height, ctx), ...paint,
      ...(clips ? { overflow: 'hidden' } : {}),
    };
    // A hug frame has no fixed size on the sides that hug, even at the top level. Older files say AUTO.
    const layout = layoutOf(node);
    if (layout && layout !== 'grid' && parent === null) {
      const row = layout === 'row';
      const hugs = (axis: 'h' | 'v') => {
        const sizing = axis === 'h' ? node.layoutSizingHorizontal : node.layoutSizingVertical;
        if (sizing) return sizing === 'HUG';
        return (axis === 'h') === row ? node.primaryAxisSizingMode === 'AUTO' : node.counterAxisSizingMode === 'AUTO';
      };
      if (hugs('h')) delete style.width;
      if (hugs('v')) delete style.height;
    }
    const main = linkedMain(node, ctx);
    // A linked instance's own layers are only compared with its main: what they note is the main's to note.
    const children = convertChildren(node, main ? quiet(ctx) : ctx);
    if (layout === 'row' || layout === 'column') {
      // Children in the flow, paired with their Figma layers in order.
      const flowing = children.filter((c) => c.style?.position === 'relative');
      const spacing = node.itemSpacing ?? 0;
      if (spacing < 0 && node.primaryAxisAlignItems !== 'SPACE_BETWEEN') flowing.slice(1).forEach((c) => { c.style![layout === 'row' ? 'marginLeft' : 'marginTop'] = px(spacing); });
      // The first child drawn on top, as Figma's "first on top" does.
      if (node.itemReverseZIndex) flowing.forEach((c, i) => { c.style!.zIndex = String(flowing.length - i); });
    }
    const spec: NewNode = { type: 'frame', name, tag: 'div', fixedId, style, ...hidden, ...(children.length ? { children } : {}) };
    if (main) return instanceNode(node, main, ctx, spec);
    if (node.type === 'INSTANCE' && !ctx.flat) ctx.notes.add('instances of components not in the import, as plain frames', node);
    if (node.type === 'COMPONENT' && !ctx.flat) markMain(node, parent, ctx);
    return spec;
  }
  ctx.notes.add(`${node.type.toLowerCase()} layers, left out`, node);
  return null;
}

/** Records a main, with its set and variant values when it is in a component set, and its properties. */
function markMain(node: FigmaNode, parent: FigmaNode | null, ctx: Context): void {
  const inSet = parent?.type === 'COMPONENT_SET';
  const variant = inSet ? variantOf(node.name ?? '') : null;
  if (inSet && !variant) ctx.notes.add('variants whose names are not Property=Value, as separate components', node);
  const defs = inSet ? parent!.componentPropertyDefinitions : node.componentPropertyDefinitions;
  const description = ctx.meta?.[node.id]?.description;
  ctx.mains?.push({
    id: idFor(ctx, node.id),
    options: {
      ...(description ? { description } : {}),
      ...(inSet && variant ? { set: parent!.name || 'Set', variant } : {}),
      props: mainProps(node, defs, ctx),
    },
  });
}

function walk(node: FigmaNode, visit: (n: FigmaNode, parent: FigmaNode | null) => boolean | void, parent: FigmaNode | null = null): void {
  if (visit(node, parent) === false) return;
  node.children?.forEach((c) => walk(c, visit, node));
}

function subtree(root: FigmaNode, id: string): FigmaNode | null {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const found = subtree(child, id);
    if (found) return found;
  }
  return null;
}

function countLayers(spec: NewNode): number {
  return 1 + (spec.children ?? []).reduce((sum, c) => sum + countLayers(c), 0);
}

export interface FigmaImportOptions {
  url: string;
  token: string;
  /** Tests only: where the API is, and a plain fetch for its download URLs. */
  apiBase?: string;
  plainDownloads?: boolean;
}

export interface FigmaData {
  name: string;
  pages: { name: string; specs: NewNode[] }[];
  /** Layers to mark as mains once they are in the document. */
  mains: FigmaMain[];
  report: Omit<FigmaImportReport, 'pages' | 'layers'>;
}

async function api<T>(base: string, path: string, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new HttpError(502, `Figma did not answer: ${errorMessage(e)}`);
  }
  if (res.status === 403) throw new HttpError(403, 'Figma refused this token for this file. Check that the token is right, has the file_content:read scope, and that you can open the file.');
  if (res.status === 404) throw new HttpError(404, 'Figma has no file at that address, or this token cannot see it.');
  if (res.status === 429) throw new HttpError(429, `Figma is rate limiting this token.${res.headers.get('retry-after') ? ` Try again in ${res.headers.get('retry-after')} seconds.` : ''}`);
  if (!res.ok) throw new HttpError(502, `Figma answered ${res.status}.`);
  return await res.json() as T;
}

const SVG_BATCH = 100;

/** Turns already fetched pages into layer specs. Exported for tests that start from recorded JSON. */
export function convertFigmaPages(
  file: FigmaFile,
  canvases: FigmaNode[],
  assets: { images: Map<string, string>; vectors: Map<string, string>; sizes?: Map<string, { width: number; height: number }> },
  /** `flat`: components and instances as plain frames, as the import did before it linked them. For comparisons. */
  options: { flat?: boolean } = {},
): { pages: FigmaData['pages']; mains: FigmaMain[]; fonts: string[]; unsupported: FigmaImportReport['unsupported']; instances: number } {
  const notes = new Notes();
  const ctx: Context = {
    ...assets, fonts: new Set(), notes, ids: new Map(), nodes: new Map(), parents: new Map(),
    meta: file.components ?? {}, mains: [], instances: { count: 0 }, ...(options.flat ? { flat: true } : {}),
  };
  for (const canvas of canvases) {
    walk(canvas, (n, parent) => {
      ctx.nodes!.set(n.id, n);
      ctx.parents!.set(n.id, parent);
    });
  }
  const pages = canvases.map((canvas) => ({
    name: canvas.name || 'Page',
    specs: (canvas.children ?? []).flatMap((child) => {
      const spec = convertNode(child, null, ctx);
      if (!spec) return [];
      // Frames at the top of a Figma page are what artboards are here. A placed instance stays one.
      if (spec.type === 'frame' && child.type !== 'GROUP' && spec.instanceOf === undefined) spec.artboard = true;
      return [spec];
    }),
  }));
  return { pages, mains: ctx.mains!, fonts: [...ctx.fonts].sort(), unsupported: notes.list(), instances: ctx.instances!.count };
}

/** Reads a file through the API and turns it into layer specs. Stores images. Writes nothing to a document. */
export async function readFigmaFile(storage: Storage, options: FigmaImportOptions): Promise<FigmaData> {
  const { key, nodeId } = parseFigmaUrl(options.url);
  const base = options.apiBase ?? 'https://api.figma.com';
  const download = async (url: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string }> => {
    if (options.plainDownloads) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`status ${res.status}`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
    }
    return fetchPublic(url, { timeoutMs: 30_000, maxBytes });
  };
  const file = await api<FigmaFile>(base, `/v1/files/${encodeURIComponent(key)}?geometry=paths`, options.token);
  if (!file.document?.children?.length) throw new HttpError(422, 'This file has no pages.');

  // The pages and frames to bring in, which a link to one frame narrows down.
  let canvases = file.document.children.filter((c) => c.type === 'CANVAS');
  if (nodeId) {
    const narrowed = canvases.flatMap((canvas) => {
      if (canvas.id === nodeId) return [canvas];
      const found = subtree(canvas, nodeId);
      return found ? [{ ...canvas, children: [found] }] : [];
    });
    if (!narrowed.length) throw new HttpError(404, `This file has no layer ${nodeId}.`);
    canvases = narrowed;
  }

  const imageRefs = new Set<string>();
  const vectorIds: string[] = [];
  for (const canvas of canvases) {
    walk(canvas, (n) => {
      for (const paint of visiblePaints(n.fills)) if (paint.type === 'IMAGE' && paint.imageRef) imageRefs.add(paint.imageRef);
      if (n.visible === false) return;
      // A boolean operation renders as one; its parts are not asked for on their own.
      if (VECTOR_TYPES.has(n.type) || isArc(n)) {
        vectorIds.push(n.id);
        return false;
      }
    });
  }

  const failed: string[] = [];
  const images = new Map<string, string>();
  const sizes = new Map<string, { width: number; height: number }>();
  if (imageRefs.size) {
    const found = await api<{ images?: Record<string, string | null>; meta?: { images?: Record<string, string | null> } }>(base, `/v1/files/${encodeURIComponent(key)}/images`, options.token);
    const urls = found.meta?.images ?? found.images ?? {};
    for (const ref of imageRefs) {
      const url = urls[ref];
      if (!url) {
        failed.push(`image ${ref}: Figma gave no download URL`);
        continue;
      }
      try {
        const got = await download(url, 64 * 1024 * 1024);
        const mime = got.contentType.split(';')[0]!.trim();
        const asset = await storage.putAsset(got.bytes, mime);
        images.set(ref, asset.src);
        const size = imageSize(got.bytes);
        if (size) sizes.set(ref, size);
      } catch (e) {
        failed.push(`image ${ref}: ${errorMessage(e)}`);
      }
    }
  }

  const vectors = new Map<string, string>();
  for (let i = 0; i < vectorIds.length; i += SVG_BATCH) {
    const ids = vectorIds.slice(i, i + SVG_BATCH);
    let rendered: { err?: string | null; images?: Record<string, string | null> };
    try {
      rendered = await api(base, `/v1/images/${encodeURIComponent(key)}?ids=${ids.map(encodeURIComponent).join(',')}&format=svg&svg_simplify_stroke=true`, options.token);
    } catch (e) {
      // The file's own paths still draw them, so a failed render is reported and not fatal.
      if (e instanceof HttpError && e.status === 403) throw e;
      failed.push(`vectors ${ids[0]}${ids.length > 1 ? ` and ${ids.length - 1} more` : ''}: ${errorMessage(e)}`);
      continue;
    }
    for (const id of ids) {
      const url = rendered.images?.[id];
      if (!url) {
        failed.push(`vector ${id}: Figma did not render it`);
        continue;
      }
      try {
        const got = await download(url, 8 * 1024 * 1024);
        const clean = sanitizeSvgMarkup(Buffer.from(got.bytes).toString('utf8'));
        if (clean) vectors.set(id, clean);
        else failed.push(`vector ${id}: not usable SVG`);
      } catch (e) {
        failed.push(`vector ${id}: ${errorMessage(e)}`);
      }
    }
  }

  const converted = convertFigmaPages(file, canvases, { images, vectors, sizes });
  return {
    name: file.name || 'Figma import',
    pages: converted.pages,
    mains: converted.mains,
    report: {
      file: file.name ?? key, images: images.size, vectors: vectors.size, components: converted.mains.length, instances: converted.instances,
      fonts: converted.fonts, unsupported: converted.unsupported, failed,
    },
  };
}

/** Puts converted pages into a document, reusing a new file's empty first page. One transaction. */
export function placeFigma(doc: BogenDoc, data: Pick<FigmaData, 'pages'> & { mains?: FigmaMain[] }, origin?: unknown): FigmaImportReport['pages'] {
  const placed: FigmaImportReport['pages'] = [];
  doc.transact(() => {
    data.pages.forEach((page, i) => {
      const existing = doc.getPages();
      const first = existing[0];
      let pageId: string;
      if (i === 0 && existing.length === 1 && first && !doc.getChildren(first.id).length) {
        pageId = first.id;
        doc.renamePage(pageId, page.name);
      } else pageId = doc.createPage(page.name);
      if (page.specs.length) doc.insertMany(pageId, page.specs);
      placed.push({ pageId, name: page.name, layers: page.specs.reduce((sum, s) => sum + countLayers(s), 0) });
    });
    // Mains are marked once every layer is in, so that instances on earlier pages find them.
    for (const main of data.mains ?? []) if (doc.source.raw(main.id)) createComponent(doc, main.id, main.options);
  }, origin);
  return placed;
}
