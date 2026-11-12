import { camelCss, type BogenDoc, type BogenNode, type NewNode, type Style } from '@bogen/core';
import { z } from 'zod';
import type { Room } from '../sync.ts';
import { assertUnlocked, fileIdArg, type ToolContext, type ToolDefiner } from './kit.ts';
import { assertSafeStyle } from './tools-write.ts';

const COPIED_LAYOUT = ['display', 'flexDirection', 'flexWrap', 'gap', 'rowGap', 'columnGap', 'alignItems', 'justifyContent', 'gridTemplateColumns', 'gridTemplateRows'];
const GONE_WITH_FRAME = ['backgroundColor', 'backgroundImage', 'background', 'border', 'borderRadius', 'boxShadow', 'padding'];
const MEASURED = ['position', 'left', 'top', 'width', 'height'];
const FLOW_PATCH: Record<string, string | null> = { position: null, left: null, top: null, right: null, bottom: null };

interface Box { id: string; absolute: boolean; left: number; top: number; width: number; height: number; x: number; y: number }

const round = (n: number) => Math.round(n * 100) / 100;
const px = (n: number) => `${round(n)}px`;

/** Where the browser really put these layers: parent-relative offsets and page position. */
async function measure(ctx: ToolContext, doc: BogenDoc, ids: string[]): Promise<Map<string, Box>> {
  const computed = await ctx.app.renderer.computed(doc, ids, MEASURED);
  const out = new Map<string, Box>();
  for (const id of ids) {
    const c = computed[id];
    if (!c || (!c.box.width && !c.box.height)) throw new Error(`Layer ${id} is hidden or has no size, so it cannot be measured. Show it with layer_set_flags, give it a width and height with layer_style, or leave it out of node_ids.`);
    const position = c.style.position;
    out.set(id, {
      id, absolute: position === 'absolute' || position === 'fixed',
      left: Number.parseFloat(c.style.left ?? '') || 0, top: Number.parseFloat(c.style.top ?? '') || 0,
      width: Number.parseFloat(c.style.width ?? '') || c.box.width, height: Number.parseFloat(c.style.height ?? '') || c.box.height,
      x: c.box.x, y: c.box.y,
    });
  }
  return out;
}

/** Sibling layers in paint order, or a clear error. */
function siblings(doc: BogenDoc, ids: string[]): { parent: string; ordered: string[] } {
  const nodes = ids.map((id) => {
    const node = doc.getNode(id);
    if (!node) throw new Error(`No layer with id ${id}. Call layer_tree to see what exists.`);
    return node;
  });
  const parent = nodes[0]!.parent;
  if (nodes.some((n) => n.parent !== parent)) throw new Error('These layers have different parents. Move them under one parent with layer_move first.');
  const wanted = new Set(ids);
  return { parent, ordered: doc.getChildren(parent).filter((c) => wanted.has(c.id)).map((c) => c.id) };
}

interface WrapOptions { name: string; tag?: string; style?: Style; flex?: Style }

/** Puts siblings in a new frame without moving them on screen, unless flex layout is asked for. */
export async function wrapLayers(ctx: ToolContext, room: Room, ids: string[], options: WrapOptions): Promise<{ id: string; children: string[] }> {
  const { doc } = room;
  assertUnlocked(doc, ids);
  const { parent, ordered } = siblings(doc, ids);
  const boxes = await measure(ctx, doc, ordered);
  const list = ordered.map((id) => boxes.get(id)!);
  const onPage = doc.pages.has(parent);
  const absolute = list.filter((b) => b.absolute).length;
  if (absolute && absolute < list.length) throw new Error('Some of these layers are absolutely positioned and some follow layout. Make them the same with layer_style or layer_move first.');
  if (onPage && !absolute) throw new Error('Layers directly on a page need a position. Set one with layer_move first.');
  const parentNode = doc.getNode(parent);

  let frameStyle: Style;
  const patches = new Map<string, Record<string, string | null>>();
  let index: number;
  const all = doc.getChildren(parent);
  if (absolute) {
    const left = Math.min(...list.map((b) => b.left));
    const top = Math.min(...list.map((b) => b.top));
    const right = Math.max(...list.map((b) => b.left + b.width));
    const bottom = Math.max(...list.map((b) => b.top + b.height));
    frameStyle = { position: 'absolute', left: px(left), top: px(top), width: px(right - left), height: px(bottom - top) };
    for (const b of list) {
      const n = doc.getNode(b.id)!;
      patches.set(b.id, options.flex ? FLOW_PATCH : { left: px(b.left - left), top: px(b.top - top), right: null, bottom: null, width: px(b.width), ...(n.type === 'text' && !n.style.height ? {} : { height: px(b.height) }) });
    }
    index = all.findIndex((c) => c.id === ordered.at(-1)) + 1;
  } else {
    // In flow the frame takes the place of the first layer, and arranges them as their parent did.
    frameStyle = {};
    if (!options.flex) for (const key of COPIED_LAYOUT) if (parentNode?.style[key]) frameStyle[key] = parentNode.style[key]!;
    index = all.findIndex((c) => c.id === ordered[0]);
  }
  if (options.flex) {
    frameStyle = { ...frameStyle, ...options.flex };
    if (absolute) {
      frameStyle.width = 'fit-content';
      frameStyle.height = 'fit-content';
    }
  }
  frameStyle = { ...frameStyle, ...options.style };

  const spec: NewNode = { type: 'frame', name: options.name, style: frameStyle, ...(options.tag ? { tag: options.tag } : {}) };
  const id = ctx.write(room, () => {
    const frame = doc.insert(parent, spec, index);
    for (const [child, patch] of patches) doc.updateStyle(child, patch);
    doc.move(ordered, frame);
    return frame;
  });
  return { id, children: ordered };
}

function plainBox(node: BogenNode): boolean {
  return !GONE_WITH_FRAME.some((key) => node.style[key]);
}

/** Moves layers by a measured distance. Layers that follow layout have no position to change. */
function applyDeltas(ctx: ToolContext, room: Room, moves: { box: Box; dx: number; dy: number }[]): void {
  ctx.write(room, () => {
    for (const { box, dx, dy } of moves) {
      if (!dx && !dy) continue;
      room.doc.updateStyle(box.id, { left: px(box.left + dx), top: px(box.top + dy), right: null, bottom: null });
    }
  });
}

function requirePositioned(boxes: Box[]): void {
  const flow = boxes.filter((b) => !b.absolute);
  if (flow.length) throw new Error(`Layers ${flow.map((b) => b.id).join(', ')} follow layout, so they have no position to change. In flex or grid, use alignItems, justifyContent and gap on the parent through layer_style instead.`);
}

export function registerLayoutTools(define: ToolDefiner): void {
  define('layers_group', { description: 'Put sibling layers in a new frame, leaving them where they are on screen. Use it to give related layers a shared parent, so that they can be moved, named or duplicated together. To add flex layout at the same time, use layer_wrap. Returns the new frame.' }, {
    node_ids: z.array(z.string()).min(1).max(200),
    name: z.string().min(1).max(200).default('Group'),
    file_id: fileIdArg,
  }, async ({ node_ids, name, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const result = await wrapLayers(ctx, room, node_ids, { name });
    ctx.touch([result.id]);
    return result;
  });

  define('layers_ungroup', { description: 'Remove frames and put their children in the frames\' place, keeping them where they are on screen when the frame was positioned. The frame\'s fill, border and layout go away with it, and the result reports when something visible was lost. Use it to flatten structure you no longer need.', destructive: true }, {
    node_ids: z.array(z.string()).min(1).max(100).describe('Frame layers with children.'),
    file_id: fileIdArg,
  }, async ({ node_ids, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    assertUnlocked(doc, node_ids);
    const released: string[] = [];
    const lost: string[] = [];
    const plans: { frame: BogenNode; kids: string[]; boxes: Map<string, Box> }[] = [];
    for (const frameId of node_ids) {
      const frame = doc.getNode(frameId);
      if (!frame) throw new Error(`No layer with id ${frameId}.`);
      const kids = doc.getChildren(frameId).map((c) => c.id);
      if (frame.type !== 'frame' || !kids.length) throw new Error(`Layer ${frameId} is not a frame with children.`);
      if (doc.ancestors(frameId).some((a) => node_ids.includes(a))) throw new Error(`Layer ${frameId} is inside another layer in this list. Ungroup them one call at a time.`);
      plans.push({ frame, kids, boxes: await measure(ctx, doc, [frameId, ...kids]) });
      if (!plainBox(frame)) lost.push(frameId);
      released.push(...kids);
    }
    ctx.write(room, () => {
      for (const { frame, kids, boxes } of plans) {
        const own = boxes.get(frame.id)!;
        const onPage = doc.pages.has(frame.parent);
        const at = doc.getChildren(frame.parent).findIndex((c) => c.id === frame.id);
        for (const kid of kids) {
          const box = boxes.get(kid)!;
          const node = doc.getNode(kid)!;
          if (own.absolute || onPage) {
            doc.updateStyle(kid, {
              position: 'absolute', left: px(own.left + box.x - own.x), top: px(own.top + box.y - own.y), right: null, bottom: null,
              width: px(box.width), ...(node.type === 'text' && !node.style.height ? {} : { height: px(box.height) }),
            });
          } else if (box.absolute) doc.updateStyle(kid, FLOW_PATCH);
        }
        doc.move(kids, frame.parent, at);
        // Not doc.delete: it walks children as they were before this transaction, the moved ones included.
        doc.nodes.delete(frame.id);
      }
    });
    ctx.touch(released);
    return { released, ...(lost.length ? { lost_styling_of: lost, note: 'These frames had a fill, border, padding or shadow, which is gone with them.' } : {}) };
  });

  define('layer_wrap', { description: 'Wrap sibling layers in a new frame, optionally with flex layout: the usual way to turn loose layers into a real row or column. With direction, the children give up absolute positions and follow the layout. Without it, this is like layers_group but lets you set the tag, the name and the frame\'s own style.' }, {
    node_ids: z.array(z.string()).min(1).max(200),
    name: z.string().min(1).max(200).default('Frame'),
    tag: z.string().regex(/^[a-z][a-z0-9]*$/).optional().describe('The HTML tag, such as section or nav.'),
    direction: z.enum(['row', 'column']).optional().describe('Make it a flex row or column.'),
    gap: z.string().optional().describe('For flex, such as 16px or var(--space-4).'),
    align: z.string().optional().describe('For flex: alignItems.'),
    justify: z.string().optional().describe('For flex: justifyContent.'),
    style: z.record(z.string(), z.string()).optional().describe('More CSS for the frame, such as {"padding":"24px","background-color":"var(--surface)"}.'),
    file_id: fileIdArg,
  }, async ({ node_ids, name, tag, direction, gap, align, justify, style, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const own: Style = {};
    for (const [key, value] of Object.entries(style ?? {})) {
      assertSafeStyle(key, value);
      own[camelCss(key)] = value;
    }
    const flex: Style | undefined = direction ? {
      display: 'flex', flexDirection: direction,
      ...(gap ? { gap } : {}), ...(align ? { alignItems: align } : {}), ...(justify ? { justifyContent: justify } : {}),
    } : undefined;
    const result = await wrapLayers(ctx, room, node_ids, { name, ...(tag ? { tag } : {}), style: own, ...(flex ? { flex } : {}) });
    ctx.touch([result.id]);
    return result;
  });

  define('layers_align', { description: 'Line up absolutely positioned layers by their measured boxes: to each other, or to their parent. A single layer aligns to its parent. Layers inside flex or grid follow layout, so this refuses them: change alignItems or justifyContent on the parent with layer_style. Works from rendered positions, not from what the styles say.' }, {
    node_ids: z.array(z.string()).min(1).max(200),
    edge: z.enum(['left', 'center', 'right', 'top', 'middle', 'bottom']).describe('center is horizontal, middle is vertical.'),
    to: z.enum(['selection', 'parent']).optional().describe('What to align to. Default is the other layers, or the parent for a single layer.'),
    file_id: fileIdArg,
  }, async ({ node_ids, edge, to, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    assertUnlocked(doc, node_ids);
    const toParent = to === 'parent' || node_ids.length === 1;
    const { parent } = siblings(doc, node_ids);
    if (toParent && doc.pages.has(parent)) throw new Error('These layers sit directly on a page, which has no box to align to. Align them to each other with several node_ids and no to, or put them in a frame first with layers_group.');
    const boxes = await measure(ctx, doc, toParent ? [...node_ids, parent] : node_ids);
    const list = node_ids.map((id) => boxes.get(id)!);
    requirePositioned(list);
    const frame = toParent ? boxes.get(parent)! : null;
    const minX = frame ? frame.x : Math.min(...list.map((b) => b.x));
    const minY = frame ? frame.y : Math.min(...list.map((b) => b.y));
    const maxX = frame ? frame.x + frame.width : Math.max(...list.map((b) => b.x + b.width));
    const maxY = frame ? frame.y + frame.height : Math.max(...list.map((b) => b.y + b.height));
    applyDeltas(ctx, room, list.map((box) => {
      const w = box.width;
      const h = box.height;
      const dx = edge === 'left' ? minX - box.x : edge === 'center' ? (minX + maxX) / 2 - (box.x + w / 2) : edge === 'right' ? maxX - (box.x + w) : 0;
      const dy = edge === 'top' ? minY - box.y : edge === 'middle' ? (minY + maxY) / 2 - (box.y + h / 2) : edge === 'bottom' ? maxY - (box.y + h) : 0;
      return { box, dx, dy };
    }));
    ctx.touch(node_ids);
    return { aligned: node_ids, edge, to: toParent ? 'parent' : 'selection' };
  });

  define('layers_distribute', { description: 'Even out the gaps between absolutely positioned layers along an axis. The outer two stay where they are, unless you set gap, which keeps the first and spaces the rest. Needs three layers, or two with gap. Layers inside flex or grid follow layout, so use gap and justifyContent on the parent there.' }, {
    node_ids: z.array(z.string()).min(2).max(200),
    axis: z.enum(['x', 'y']),
    gap: z.number().optional().describe('A fixed gap in px.'),
    file_id: fileIdArg,
  }, async ({ node_ids, axis, gap, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const { doc } = room;
    assertUnlocked(doc, node_ids);
    if (node_ids.length < 3 && gap === undefined) throw new Error('Distributing needs three layers, or two with gap.');
    const boxes = await measure(ctx, doc, node_ids);
    const list = node_ids.map((id) => boxes.get(id)!);
    requirePositioned(list);
    const start = (b: Box) => (axis === 'x' ? b.x : b.y);
    const size = (b: Box) => (axis === 'x' ? b.width : b.height);
    const sorted = [...list].sort((a, b) => start(a) - start(b));
    const span = start(sorted.at(-1)!) + size(sorted.at(-1)!) - start(sorted[0]!);
    const total = sorted.reduce((sum, b) => sum + size(b), 0);
    const spacing = gap ?? (span - total) / (sorted.length - 1);
    let cursor = start(sorted[0]!);
    applyDeltas(ctx, room, sorted.map((box) => {
      const delta = cursor - start(box);
      cursor += size(box) + spacing;
      return { box, dx: axis === 'x' ? delta : 0, dy: axis === 'y' ? delta : 0 };
    }));
    ctx.touch(node_ids);
    return { distributed: sorted.map((b) => b.id), axis, gap: round(spacing) };
  });
}
