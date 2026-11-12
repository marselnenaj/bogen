import { newId, readCanvasPlan, blockKey, camelCss, FRAME_PRESETS, framePreset, checkAttrs, cleanRuleProp, cleanRuleValue, resolveInstanceRefs, importHtml, keyframesName, safeUrl, sanitizeSvgMarkup, setSvgRootAttrs, svgRootAttr, type BogenDoc, type NewNode, type Style } from '@bogen/core';
import { dropInvalidCss } from '@bogen/core/css-check';
import { z } from 'zod';
import { MAKE_IMAGES, mentionsGeneration, NO_GENERATION, readLocalImage, resolveImages, sniffImage } from '../images.ts';
import { assertUnlocked, fileIdArg, nextArtboardX, outline, pageIdArg, type ToolContext, type ToolDefiner } from './kit.ts';

const MAX_HTML = 256 * 1024;
const NEXT_STEP = 'Review with canvas_screenshot before writing more. For several screens, keep the task-based sections and state/variant lanes in canvas_plan_set current.';
/** Decoded bytes. In base64 this still fits the limit of one MCP message. */
const MAX_UPLOAD = 5 * 1024 * 1024;
/** For a file the server reads itself: the same as an upload over HTTP. */
const MAX_FILE = 64 * 1024 * 1024;
const LOOPBACK = new Set([undefined, '127.0.0.1', 'localhost', '::1']);
const UPLOAD_TYPES =['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'] as const;

function keyframeBlocks(doc: BogenDoc): string[] {
  const existing = doc.meta.get('keyframes');
  return Array.isArray(existing) ? (existing as unknown[]).filter((k): k is string => typeof k === 'string') : [];
}

export function assertSafeStyle(prop: string, value: string): void {
  if (/expression\s*\(|javascript:|@import/i.test(value)) throw new Error(`The value of ${prop} is not allowed: expression(), javascript: and @import are refused. Write the value as plain CSS, and an image as url() of an asset_upload src.`);
}

/** Layers directly on a page need a position, or they would pile up at the origin. */
function placeOnPage(doc: BogenDoc, pageId: string, specs: NewNode[], keep?: Style): void {
  let x = nextArtboardX(doc, pageId);
  specs.forEach((spec, i) => {
    const style: Style = { ...spec.style };
    if (keep && i === 0) {
      for (const k of ['position', 'left', 'top']) if (keep[k] && !style[k]) style[k] = keep[k]!;
    }
    if (!style.position || style.position === 'static' || style.position === 'relative') style.position = 'absolute';
    if (!style.left) {
      style.left = `${x}px`;
      if (!style.top) style.top = '0px';
      x += (Number.parseFloat(style.width ?? '') || 1440) + 80;
    }
    if (!style.top) style.top = '0px';
    // An instance takes its size from its main, and is not a screen of its own.
    const linked = spec.instanceRef !== undefined || spec.instanceOf !== undefined;
    if (!linked && !style.width && spec.type !== 'text') style.width = '1440px';
    spec.style = style;
    if (!linked && spec.type === 'frame') spec.artboard = true;
  });
}

function htmlWarnings(html: string): string[] {
  const out: string[] = [];
  if (/\sclass\s*=/.test(html) && !/<style[\s>]/i.test(html)) out.push('Class attributes have no effect without a <style> block in the same call, so Tailwind and the like do nothing here. Use inline styles.');
  if (/<script[\s>]/i.test(html)) out.push('Scripts are removed. Designs are static HTML and CSS.');
  if (/<link[\s>]/i.test(html)) out.push('<link> is removed. Set fontFamily and the font loads by itself.');
  if (/\son[a-z]+\s*=/i.test(html)) out.push('Event handlers are removed.');
  if (mentionsGeneration(html)) out.push(NO_GENERATION);
  return out;
}

function addKeyframes(doc: BogenDoc, keyframes: string[]): void {
  if (!keyframes.length) return;
  const existing = doc.meta.get('keyframes');
  const list = Array.isArray(existing) ? (existing as string[]) : [];
  doc.meta.set('keyframes', [...new Set([...list, ...keyframes])]);
}

function requireLayer(doc: BogenDoc, id: string) {
  const node = doc.getNode(id);
  if (!node) throw new Error(`No layer with id ${id}. Call layer_tree to see what exists.`);
  return node;
}

async function writeHtml(ctx: ToolContext, args: { html: string; mode: 'append' | 'prepend' | 'replace' | 'into'; target_id?: string; index?: number; page_id?: string; file_id?: string }) {
  const { html, mode, index, file_id } = args;
  if (html.length > MAX_HTML) throw new Error(`That is ${Math.round(html.length / 1024)} KB of HTML, over the limit of 256 KB. Write it in smaller chunks, one section per call.`);
  const room = await ctx.room(file_id);
  const doc = room.doc;
  if (mode === 'replace' && !args.target_id) throw new Error('mode "replace" needs target_id, the layer to replace.');
  if (mode === 'replace' && args.target_id?.includes('/')) throw new Error(`Layer ${args.target_id} is inside an instance, so it cannot be replaced there. Edit the main, or override what you need with instance_set.`);
  const target = args.target_id ?? ctx.page(room, args.page_id);
  if (doc.pages.has(target)) ctx.page(room, target);
  else assertUnlocked(doc, [target]);

  const { nodes, keyframes, droppedRules } = importHtml(html);
  if (!nodes.length) throw new Error('The HTML has no visible content. Note that scripts and head elements are dropped.');
  resolveInstanceRefs(doc, nodes);
  // A browser drops these anyway. Kept, they would sit in the inspector doing nothing.
  const invalid = dropInvalidCss(nodes);
  const warnings = [...htmlWarnings(html), ...(ctx.dryRun ? [] : await resolveImages(ctx.app.storage, nodes))];
  if (invalid.length) warnings.push(`${invalid.length} CSS declaration${invalid.length > 1 ? 's were' : ' was'} dropped, as a browser would ignore ${invalid.length > 1 ? 'them' : 'it'}: ${invalid.slice(0, 8).join(' | ')}${invalid.length > 8 ? ' | …' : ''}. The rest was written; fix these with layer_style.`);
  if (droppedRules.length) warnings.push(`${droppedRules.length} style rule${droppedRules.length > 1 ? 's were' : ' was'} not kept, as a layer cannot hold ${droppedRules.length > 1 ? 'them' : 'it'}: ${droppedRules.slice(0, 5).join(' | ')}${droppedRules.length > 5 ? ' | …' : ''}. Kept are pseudo-elements, one @media or @container, and a state on the element or its parent.`);

  const ids = ctx.write(room, () => {
    addKeyframes(doc, keyframes);
    if (mode === 'replace') {
      const old = requireLayer(doc, target);
      const position = doc.getChildren(old.parent).findIndex((c) => c.id === target);
      if (doc.pages.has(old.parent)) {
        doc.delete([target]);
        placeOnPage(doc, old.parent, nodes, old.style);
      } else doc.delete([target]);
      return doc.insertMany(old.parent, nodes, position);
    }
    if (doc.pages.has(target)) placeOnPage(doc, target, nodes);
    const at = mode === 'prepend' ? 0 : mode === 'into' ? index : undefined;
    return doc.insertMany(target, nodes, at);
  });
  ctx.touch(ids);
  return { ids, tree: outline(doc, ids, 3, 60), ...(warnings.length ? { warnings } : {}), next: NEXT_STEP };
}

/** How wide layers render now, so that one taken out of its parent keeps its size. Empty without a browser. */
async function measuredWidths(ctx: ToolContext, room: Awaited<ReturnType<ToolContext['room']>>, ids: string[]): Promise<Map<string, number>> {
  const doc = room.doc;
  // An artboard with a width in px already says how wide it is.
  const unsized = ids.filter((id) => !/^-?[\d.]+px$/.test(doc.getNode(id)?.style.width ?? ''));
  if (!unsized.length) return new Map();
  try {
    const entries = await ctx.app.renderer.layout(doc, { nodeIds: unsized }, unsized);
    return new Map(entries.map((e) => [e.id, e.width]));
  } catch {
    return new Map();
  }
}

/** Comments pinned to moved layers, or to layers inside them, go with them to their new page. */
function moveThreads(doc: BogenDoc, ids: string[], pageId: string): void {
  if (!ids.length) return;
  const moved = new Set(ids);
  for (const id of ids) for (const d of doc.descendants(id)) moved.add(d.id);
  doc.comments.forEach((thread) => {
    const nodeId = thread.get('nodeId');
    if (typeof nodeId === 'string' && moved.has(nodeId) && thread.get('pageId') !== pageId) thread.set('pageId', pageId);
  });
}

/** layer_style for a pseudo-element or a condition: checked as strictly as a style element needs, since that is where it goes. */
function styleBlock(ctx: ToolContext, room: Awaited<ReturnType<ToolContext['room']>>, ids: string[], style: Record<string, string | null>, pseudo: string | undefined, when: string | undefined, clear: boolean) {
  const doc = room.doc;
  const key = blockKey(when, pseudo);
  if ('error' in key) throw new Error(key.error);
  const patch: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(style)) {
    const prop = cleanRuleProp(camelCss(k));
    if (!prop) throw new Error(`${k} is not a CSS property name. Write properties in camelCase or kebab-case, such as backgroundColor or background-color, and custom properties with two dashes, such as --gap.`);
    if (v === null || v === '') {
      patch[prop] = null;
      continue;
    }
    assertSafeStyle(k, v);
    const value = cleanRuleValue(v);
    if (!value) throw new Error(`The value of ${k} cannot go into a style sheet: it has a brace, a semicolon outside a string or brackets, an unclosed quote or bracket, or markup.`);
    patch[prop] = value;
  }
  if (!clear && !Object.keys(patch).length) throw new Error('Give style, or clear_block true to remove the block.');
  for (const id of ids) requireLayer(doc, id);
  ctx.write(room, () => {
    for (const id of ids) {
      if (clear) doc.deleteRules(id, key.key);
      if (Object.keys(patch).length) doc.updateRules(id, key.key, patch);
    }
  });
  ctx.touch(ids);
  const warnings: string[] = [];
  const isPseudo = /::(before|after)$/.test(key.key);
  const node = doc.getNode(ids[0]!);
  if (isPseudo && node && !node.rules?.[key.key]?.content && !clear) warnings.push(`${key.key.match(/::\w+$/)![0]} shows nothing until it has content, such as {"content":"\\"\\""} for a drawn shape.`);
  if (isPseudo && ids.some((id) => capturedPseudo(doc, id))) warnings.push('This layer came from a Capture of a live page, which already turned its ::before and ::after into child layers (named Before and After, or after their text). Remove that child, or the pseudo-element shows twice.');
  if (/^@container/.test(key.key) && node && !ancestorContainer(doc, ids[0]!)) warnings.push('No layer around this one has container-type, so the container query has nothing to measure. Give the container container-type: inline-size with layer_style.');
  return { updated: ids.length, block: key.key, rules: node?.rules ?? {}, ...(warnings.length ? { warnings } : {}) };
}

/** Whether a layer sits in an artboard captured with Capture, where pseudo-elements became layers. */
function capturedPseudo(doc: BogenDoc, id: string): boolean {
  const top = doc.ancestors(id).at(-1) ?? id;
  if (!doc.y.getMap('snapshotSources').has(top)) return false;
  const kids = doc.getChildren(id);
  return [kids[0], kids.at(-1)].some((c) => c?.tag === 'span' && (c.name === 'Before' || c.name === 'After'));
}

function ancestorContainer(doc: BogenDoc, id: string): boolean {
  return doc.ancestors(id).some((a) => /size/.test(doc.getNode(a)?.style.containerType ?? '') || /size/.test(doc.getNode(a)?.style.container ?? ''));
}

export function registerWriteTools(define: ToolDefiner): void {
  define('artboard_create', { description: 'Create a top-level screen, flex-column by default; omit height to hug content. Fill it incrementally with html_write. For several screens, read canvas_plan_get and use section_id/lane_title to group them, then canvas_plan_set to arrange. Default placement is temporary. See guide_get layout' }, {
    name: z.string().min(1).max(200).describe('Such as "Home, desktop".'),
    width: z.number().min(1).max(10000).default(1440).describe('1440 desktop, 768 tablet, 390 mobile.'),
    height: z.number().min(1).max(20000).optional().describe('Fixed height. Leave out to hug content. Use for slides, posters and fixed app screens.'),
    preset: z.string().max(60).optional().describe(`A named size instead of width and height, fixed in both: ${FRAME_PRESETS.map((p) => p.name).join(', ')}.`),
    landscape: z.boolean().optional().describe('With preset: swap width and height.'),
    x: z.number().optional().describe('Position on the page. Default is the next free spot.'),
    y: z.number().default(0),
    section_id: z.string().max(80).optional().describe('Existing canvas-plan section id. Plan named sections and lanes before creating a flow; this adds the new screen to that section immediately.'),
    lane_title: z.string().max(120).optional().describe('Exact unique lane title inside section_id, such as Main path, Error states or Mobile variants. After filling the screens, finish the arrangement with canvas_plan_set.'),
    background: z.string().default('#ffffff').describe('A CSS colour, or a token as var(--bg).'),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ name, width: givenWidth, height: givenHeight, preset, landscape, x, y, section_id, lane_title, background, page_id, file_id }, ctx) => {
    const named = preset ? framePreset(preset) : undefined;
    if (preset && !named) throw new Error(`No preset called "${preset}". There are: ${FRAME_PRESETS.map((p) => p.name).join(', ')}.`);
    const width = named ? (landscape ? named.h : named.w) : givenWidth;
    const height = named ? (landscape ? named.w : named.h) : givenHeight;
    const room = await ctx.room(file_id);
    const pageId = ctx.page(room, page_id);
    assertSafeStyle('background', background);
    const left = x ?? nextArtboardX(room.doc, pageId);
    const brandFont = await ctx.app.brands.bodyFont(room);
    const grouping = section_id || lane_title ? structuredClone(readCanvasPlan(room.doc, pageId)) : null;
    const section = grouping?.sections.find(s => s.id === section_id);
    const lanes = section?.lanes.filter(l => l.title === lane_title) ?? [];
    if (grouping && (!section_id || !lane_title || lanes.length !== 1)) throw new Error('Nothing was created. Read canvas_plan_get and supply an existing section_id and unique lane_title; create the named plan first.');
    if (grouping && grouping.sections.flatMap(s => s.lanes.flatMap(l => l.node_ids)).length >= 500) throw new Error('This canvas plan already has 500 screens. Split independent flows across pages.');
    const id = ctx.write(room, () => {
      const id = room.doc.insert(pageId, {
      type: 'frame', tag: 'main', name, artboard: true,
      style: {
        position: 'absolute', left: `${left}px`, top: `${y}px`, width: `${width}px`, height: height ? `${height}px` : 'fit-content',
        display: 'flex', flexDirection: 'column', backgroundColor: background, overflow: 'hidden', ...(brandFont ? { fontFamily: brandFont } : {}),
      },
    });
      if (grouping) {
        lanes[0]!.node_ids.push(id);
        room.doc.meta.set(`canvasPlan:${pageId}`, { ...grouping, revision: grouping.revision + 1, revision_id: newId(), layout_pending: true });
      }
      return id;
    });
    ctx.touch([id]);
    const plan = readCanvasPlan(room.doc, pageId);
    const screenCount = room.doc.getChildren(pageId).filter(n => n.artboard && !n.hidden).length;
    return { id, name, page_id: pageId, x: left, y, width, height: height ?? 'hug', ...(screenCount >= 3 || grouping ? { organization: { screens: screenCount, planned_sections: plan.sections.length, layout_pending: Boolean(plan.layout_pending), next: 'Read canvas_plan_get, add this screen to its meaningful section/lane, then canvas_plan_set with dry_run. Do not leave unrelated screens in a row or generic grid.' } } : {}) };
  });

  define('html_write', { description: `Write real HTML to the canvas. Each element becomes an editable layer. This is your main drawing tool.

Write one section per call: small chunks let the person follow along, and mistakes stay cheap. Use inline style attributes, semantic tags, real flex or grid, and var(--token) values. A <style> block in the same call also works; its rules are applied to the elements, and ::before, ::after, @media, @container and :hover rules stay on the layers they match (guide_get layout). Scripts, event handlers and external stylesheets are removed. For fonts just set font-family.

Components: <x-instance component="Button" prop-label="Buy" prop-size="lg" style="width:100%"></x-instance> places a linked instance of a component by name or id, with props and variant values as prop-*; children fill its slot, and slot="name" on a child picks one. data-slot="name" on a frame marks a slot for a component you are about to make, and text-style="Heading 1" on a text element uses a text style. Repeating something? Make it a component rather than writing its markup again.

Images: <img src="https://..."> is stored with the file, and a src from asset_upload works. ${MAKE_IMAGES} An <img> with no src but a width and height is a placeholder for a draft. Inline <svg> stays editable as a vector. Shaders: <x-shader type="mesh-gradient" colors="#000,#f50"> (see guide_get shaders).

Modes: append (default) adds to the end of target_id. prepend adds to its start. into inserts at index. replace swaps target_id for the new HTML, which is how you redo a section. Without target_id it writes to the current page, but usually you want an artboard from artboard_create.` }, {
    html: z.string().min(1),
    mode: z.enum(['append', 'prepend', 'replace', 'into']).default('append'),
    target_id: z.string().optional().describe('A frame layer, or a page id. Required for replace.'),
    index: z.number().int().min(0).optional().describe('For mode into: the position among the children of target_id.'),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, (args, ctx) => writeHtml(ctx, args));

  define('page_capture', { description: 'Capture a live public web page onto the canvas as a new artboard of editable layers, with real text, images, vectors and CSS. The page\'s CSS custom properties become tokens if the file has none yet. Use it to bring an existing site into a design, then change it. Pages on private addresses are refused; the person can capture those with `bogen capture`. Capturing a site again in the other color_scheme fills in that theme mode\'s token values and makes both artboards use tokens, instead of leaving a second set of hard-coded colours.' }, {
    url: z.string().url(),
    width: z.number().int().min(200).max(4000).default(1440).describe('Viewport width: 1440 desktop, 768 tablet, 390 mobile.'),
    height: z.number().int().min(200).max(4000).default(900),
    color_scheme: z.enum(['light', 'dark']).optional(),
    mode: z.string().regex(/^[a-zA-Z_][\w-]*$/).optional().describe('The theme mode this capture fills in. Default is color_scheme, when the file already has this site in the other scheme.'),
    pair_with: z.string().optional().describe('An artboard of the same site to compare with, for one captured before Bogen kept track of that.'),
    name: z.string().min(1).max(200).optional(),
    page_id: pageIdArg,
    file_id: fileIdArg,
  }, async ({ url, width, height, color_scheme, mode, pair_with, name, page_id, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const placed = await ctx.app.capturePageInto(room.id, { url, width, height, ...(color_scheme ? { colorScheme: color_scheme } : {}), ...(mode ? { mode } : {}), ...(pair_with ? { pairWith: pair_with } : {}), ...(name ? { name } : {}), ...(page_id ? { pageId: page_id } : {}), allowLocal: false }, `agent:${ctx.agent}`);
    ctx.touch([placed.nodeId]);
    return { node_id: placed.nodeId, page_id: placed.pageId, layers: placed.layers, images: placed.images, failed_images: placed.failedImages, tokens: placed.tokens, title: placed.title, ...(placed.modes ? { modes: placed.modes } : {}) };
  });

  define('layer_style', { description: 'Change CSS on one or more layers. Merges into the existing style. Set a property to null to remove it. Use for adjustments; rewriting a whole section with html_write is for bigger changes. With pseudo and/or when it changes a pseudo-element or a conditional block instead of the layer\'s own style: pseudo "::before" with {"content":"\\"+\\""}, when "@container (max-width: 560px)", "@media (max-width: 760px)", ":hover" or "parent[open]". Media width queries read the artboard\'s width on the canvas and in screenshots. clear_block true removes that whole block.' }, {
    node_ids: z.array(z.string()).min(1).max(200),
    style: z.record(z.string(), z.string().nullable()).default({}).describe('Such as {"gap":"24px","background-color":"var(--surface)","border":null}. Either camelCase or kebab-case names.'),
    pseudo: z.string().optional().describe('A pseudo-element: ::before, ::after, ::marker, ::placeholder, ::selection, ::first-letter or ::first-line. A ::before or ::after needs a content value to show.'),
    when: z.string().optional().describe('A condition: "@media (max-width: 760px)", "@container (max-width: 560px)" or "@container card (min-width: 400px)", a state ":hover", ":focus", ":focus-visible", ":focus-within", ":active", "[open]", the parent\'s state "parent:hover" or "parent[open]", or an at-rule then a state, "@media (max-width: 760px) :hover". A query may use var(--breakpoint-token). The container needs container-type in its own style.'),
    clear_block: z.boolean().optional().describe('With pseudo or when: remove the whole block.'),
    file_id: fileIdArg,
  }, async ({ node_ids, style, pseudo, when, clear_block, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    assertUnlocked(room.doc, node_ids);
    if (pseudo !== undefined || when !== undefined) return styleBlock(ctx, room, node_ids, style, pseudo, when, Boolean(clear_block));
    if (clear_block) throw new Error('clear_block needs pseudo or when: the block to remove.');
    const patch: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(style)) {
      if (v !== null) assertSafeStyle(k, v);
      patch[camelCss(k)] = v;
    }
    ctx.canvasOnly = Object.keys(patch).length > 0 && Object.keys(patch).every(k => k === 'left' || k === 'top') && node_ids.every(id => {
      const n = room.doc.getNode(id);
      return n?.artboard && room.doc.pages.has(n.parent) && n.style.position === 'absolute' && !n.style.right && !n.style.bottom;
    });
    ctx.write(room, () => {
      for (const id of node_ids) room.doc.updateStyle(id, patch);
    });
    ctx.touch(node_ids);
    return { updated: node_ids.length, style: room.doc.getNode(node_ids[0]!)?.style };
  });

  define('layer_text', { description: 'Replace the text of a text layer. Line breaks are kept. The layer keeps its style.' }, {
    node_id: z.string(),
    text: z.string(),
    file_id: fileIdArg,
  }, async ({ node_id, text, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const node = requireLayer(room.doc, node_id);
    assertUnlocked(room.doc, [node_id]);
    if (node.type !== 'text') throw new Error(`Layer ${node_id} is a ${node.type}, not text. Use layer_tree to find its text layers.`);
    ctx.write(room, () => room.doc.updateFields(node_id, { text }));
    ctx.touch([node_id]);
    return { id: node_id, text };
  });

  define('layer_rename', { description: 'Rename a layer. Clear names help the person, and help you find layers again.' }, {
    node_id: z.string(),
    name: z.string().min(1).max(200),
    file_id: fileIdArg,
  }, async ({ node_id, name, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    requireLayer(room.doc, node_id);
    ctx.write(room, () => room.doc.updateFields(node_id, { name }));
    ctx.touch([node_id]);
    return { id: node_id, name };
  });

  define('layer_move', { description: 'Move layers to another parent or position among siblings, or set x and y. Reordering children of a flex container changes the layout, which is the normal way to rearrange. Set x and y only on artboards and absolutely positioned layers. To move an artboard, or any layer, to another page, give page_id: it keeps its id, its contents and the comments pinned to it, lands to the right of what is on that page unless x and y say where, and a frame becomes an artboard there. One undo step either way.' }, {
    node_ids: z.array(z.string()).min(1).max(200),
    parent_id: z.string().optional().describe('A frame layer or page id. Leave out to stay in the current parent.'),
    page_id: z.string().optional().describe('Move the layers to the top level of this page, as artboards. Use instead of parent_id.'),
    index: z.number().int().min(0).optional().describe('Position among the new siblings. Default is the end.'),
    x: z.number().optional().describe('Sets left in px.'),
    y: z.number().optional().describe('Sets top in px.'),
    file_id: fileIdArg,
  }, async ({ node_ids, parent_id, page_id, index, x, y, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const doc = room.doc;
    assertUnlocked(doc, node_ids);
    if (page_id !== undefined && parent_id !== undefined) throw new Error('Give parent_id or page_id, not both.');
    if (page_id !== undefined && !doc.pages.has(page_id)) throw new Error(`No page with id ${page_id}. Call page_list to see the pages.`);
    if (parent_id && !doc.pages.has(parent_id)) assertUnlocked(doc, [parent_id]);
    if (parent_id === undefined && page_id === undefined && index === undefined && x === undefined && y === undefined) throw new Error('Give parent_id, page_id, index, x or y.');
    for (const id of node_ids) requireLayer(doc, id);
    const toPage = page_id ?? (parent_id !== undefined && doc.pages.has(parent_id) ? parent_id : undefined);
    // Layers that arrive at the top of a page need a place there. What already was at the top stays where it is.
    const arriving = toPage ? node_ids.filter((id) => doc.getNode(id)?.parent !== toPage) : [];
    const widths = arriving.length ? await measuredWidths(ctx, room, arriving) : new Map<string, number>();
    ctx.write(room, () => {
      let left = toPage && arriving.length ? nextArtboardX(doc, toPage) : 0;
      if (parent_id !== undefined || page_id !== undefined || index !== undefined) {
        const parent = toPage ?? parent_id ?? requireLayer(doc, node_ids[0]!).parent;
        const from = new Map(node_ids.map((id) => [id, doc.pageOf(id)]));
        doc.move(node_ids, parent, index);
        if (toPage) moveThreads(doc, node_ids.filter((id) => from.get(id) !== toPage), toPage);
      }
      for (const id of arriving) {
        const node = doc.getNode(id)!;
        const width = widths.get(id);
        const patch: Record<string, string> = { position: 'absolute', left: `${left}px`, top: node.artboard && node.style.top ? node.style.top : '0px' };
        if (width !== undefined && !/^-?[\d.]+px$/.test(node.style.width ?? '')) patch.width = `${Math.round(width)}px`;
        doc.updateStyle(id, patch);
        if (node.type === 'frame' && !node.artboard && node.instanceOf === undefined) doc.updateFields(id, { artboard: true });
        left += (width ?? (Number.parseFloat(patch.width ?? node.style.width ?? '') || 1440)) + 80;
      }
      if (x !== undefined || y !== undefined) {
        for (const id of node_ids) {
          const patch: Record<string, string> = {};
          if (x !== undefined) patch.left = `${x}px`;
          if (y !== undefined) patch.top = `${y}px`;
          const position = doc.getNode(id)?.style.position;
          if (position !== 'absolute' && position !== 'fixed') patch.position = 'absolute';
          doc.updateStyle(id, patch);
        }
      }
    });
    ctx.touch(node_ids);
    return { moved: node_ids, parents: [...new Set(node_ids.map((id) => doc.getNode(id)?.parent))], ...(toPage ? { page_id: toPage } : {}) };
  });

  define('layer_duplicate', { description: 'Copy layers with everything inside them. Each copy lands right after its original. Useful for repeated items, and for trying a variation next to an artboard; move an artboard copy aside with layer_move.' }, {
    node_ids: z.array(z.string()).min(1).max(100),
    file_id: fileIdArg,
  }, async ({ node_ids, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    for (const id of node_ids) requireLayer(room.doc, id);
    const ids = ctx.write(room, () => room.doc.duplicate(node_ids));
    ctx.touch(ids);
    return { ids };
  });

  define('layer_delete', { description: 'Delete layers and everything inside them. The person can undo this per agent.', destructive: true }, {
    node_ids: z.array(z.string()).min(1).max(200),
    file_id: fileIdArg,
  }, async ({ node_ids, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    assertUnlocked(room.doc, node_ids);
    ctx.write(room, () => room.doc.delete(node_ids));
    ctx.touch([]);
    return { deleted: node_ids };
  });

  define('layer_set_flags', { description: 'Hide or show layers, or lock and unlock them. Locked layers cannot be changed by agent tools. A hidden layer renders as display:none. Unlock something only if the person asked.' }, {
    node_ids: z.array(z.string()).min(1).max(200),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
    file_id: fileIdArg,
  }, async ({ node_ids, hidden, locked, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    for (const id of node_ids) requireLayer(room.doc, id);
    if (hidden === undefined && locked === undefined) throw new Error('Give hidden or locked.');
    ctx.write(room, () => {
      for (const id of node_ids) {
        if (hidden !== undefined) room.doc.updateFields(id, { hidden: hidden || undefined });
        if (locked !== undefined) room.doc.updateFields(id, { locked: locked || undefined });
      }
    });
    ctx.touch(node_ids);
    return { updated: node_ids, hidden, locked };
  });

  define('layer_attrs', { description: 'Set HTML attributes and media sources that are not CSS: alt on an image, href and target on a link, aria-label, placeholder, src on an image or video, poster, the parameters of a shader layer (colors, speed, distortion and so on), and on an svg layer the drawing attributes of its <svg> (viewBox, preserveAspectRatio, fill, stroke, stroke-width and the like). Set one to null to remove it. These pass the same rules as stored documents: event handlers and script URLs are refused with an error, and nothing is applied then. For CSS use layer_style; to change text use layer_text.' }, {
    node_id: z.string(),
    attrs: z.record(z.string(), z.string().nullable()).describe('Such as {"alt":"Founder portrait"}, {"href":"https://example.com","target":"_blank"} or, on a shader, {"colors":"#111,#f50","speed":"0.4"}.'),
    file_id: fileIdArg,
  }, async ({ node_id, attrs, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const node = requireLayer(room.doc, node_id);
    assertUnlocked(room.doc, [node_id]);
    const { src, ...given } = attrs;
    // On an svg layer, drawing attributes such as viewBox belong to the svg element, not the layer around it.
    const onSvg = (name: string) => node.type === 'svg' && !!svgRootAttr(name);
    const svgPatch = Object.fromEntries(Object.entries(given).filter(([k]) => onSvg(k)));
    const rest = Object.fromEntries(Object.entries(given).filter(([k]) => !onSvg(k)));
    const verdict = checkAttrs(node.type, Object.fromEntries(Object.entries(given).filter((e): e is [string, string] => e[1] !== null)));
    if (verdict.rejected.length) throw new Error(`Nothing was changed. ${verdict.rejected.map((r) => `${r.name}: ${r.reason}`).join(' ')}`);
    if (!Object.keys(attrs).length) throw new Error('Give at least one attribute.');
    const patch: { attrs?: Record<string, string> | undefined; src?: string | undefined; svg?: string } = {};
    if (Object.keys(svgPatch).length) patch.svg = setSvgRootAttrs(node.svg ?? '', svgPatch);
    if (src !== undefined) {
      if (node.type !== 'image' && node.type !== 'video' && node.type !== 'embed') throw new Error(`Nothing was changed. A ${node.type} layer has no src: only image, video and embed layers do. For a picture behind a frame, set backgroundImage with layer_style.`);
      if (src !== null && (!safeUrl(src) || /^data:/i.test(src))) throw new Error('Nothing was changed. src must be an http or https URL, a path, or a bogen-asset: name. For image data or a file use asset_upload first.');
      patch.src = src ?? undefined;
    }
    const merged: Record<string, string> = { ...(node.attrs ?? {}), ...verdict.clean };
    for (const [key, value] of Object.entries(rest)) if (value === null) delete merged[key];
    if (Object.keys(rest).length) patch.attrs = Object.keys(merged).length ? merged : undefined;
    ctx.write(room, () => room.doc.updateFields(node_id, patch));
    ctx.touch([node_id]);
    return { id: node_id, attrs: patch.attrs ?? node.attrs ?? {}, ...(patch.src ? { src: patch.src } : {}), ...(patch.svg !== undefined ? { svg: Object.fromEntries(Object.entries(svgPatch).map(([k, v]) => [svgRootAttr(k), v])) } : {}) };
  });

  define('keyframes_get', { description: 'The CSS animations defined in the file, by name. Layers use one through the animation property.', readOnly: true }, { file_id: fileIdArg }, async ({ file_id }, ctx) => {
    const { doc } = await ctx.room(file_id);
    return keyframeBlocks(doc).flatMap((css) => {
      const name = keyframesName(css);
      return name ? [{ name, css }] : [];
    });
  });

  define('keyframes_set', { description: 'Create, replace or delete a CSS animation in the file, then apply it with layer_style, such as {"animation":"rise 600ms ease-out both"}. Screenshots show one still moment of the animation, and an exported html page plays it. Pass css null to delete.' }, {
    name: z.string().regex(/^[a-zA-Z_][\w-]*$/),
    css: z.string().max(20_000).nullable().describe('The frames, such as "from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}".'),
    file_id: fileIdArg,
  }, async ({ name, css, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const others = keyframeBlocks(room.doc).filter((k) => keyframesName(k) !== name);
    let block: string | null = null;
    if (css !== null) {
      const frames = css.trim().replace(/^@(-webkit-)?keyframes\s+[^{]*\{([\s\S]*)\}$/i, '$2');
      block = `@keyframes ${name}{${frames}}`;
      if (!frames.includes('{') || keyframesName(block) !== name) throw new Error('That is not a plain @keyframes body. Write frames such as from{opacity:0}to{opacity:1}, with no at-rules, script URLs or angle brackets.');
    }
    ctx.write(room, () => room.doc.meta.set('keyframes', block ? [...others, block] : others));
    return { name, ...(block ? { css: block, usage: `layer_style with {"animation":"${name} 600ms ease-out both"}` } : { deleted: true }) };
  });

  define('asset_upload', { description: `Store an image and get a src to use in html_write or layer_attrs: one your own image tool made, or a file from the person's repository. Bogen has no image generator, so this is how a bitmap gets in. Give path for a file on this computer, such as the one your image tool saved; the server reads it, up to ${MAX_FILE / 1024 / 1024} MB. Or send a small file as data_base64, up to ${MAX_UPLOAD / 1024 / 1024} MB. PNG, JPEG, WebP, GIF, AVIF and SVG. The bytes must be what mime_type says; with path, mime_type can be left out. SVG is sanitized the same way as inline SVG. Identical bytes give the same src. To fill a placeholder <img>, set its src with layer_attrs.` }, {
    path: z.string().min(1).max(4096).optional().describe('An image file on this computer, as an absolute path (~/ works), under the home or temp folder.'),
    data_base64: z.string().min(1).optional().describe('Or the file as base64, with or without a data: prefix.'),
    mime_type: z.enum(UPLOAD_TYPES).optional().describe('Required with data_base64.'),
  }, async ({ path, data_base64, mime_type }, ctx) => {
    if (Boolean(path) === Boolean(data_base64)) throw new Error('Give either path or data_base64.');
    let bytes: Buffer;
    if (path) {
      if (!LOOPBACK.has(ctx.app.options.host)) throw new Error('path works only on a server that listens on this machine alone. Send the file as data_base64.');
      bytes = await readLocalImage(path, MAX_FILE);
    } else {
      if (!mime_type) throw new Error('data_base64 needs mime_type, such as image/png, image/jpeg, image/webp or image/svg+xml.');
      const raw = data_base64!.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
      if (raw.length > Math.ceil(MAX_UPLOAD / 3) * 4) throw new Error(`That is over the limit of ${MAX_UPLOAD / 1024 / 1024} MB. Give path instead.`);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw new Error('That is not valid base64. Send the bytes of the file as standard base64 (a data: prefix and line breaks are fine), or give path for a file on this computer.');
      bytes = Buffer.from(raw, 'base64');
    }
    let type: string;
    if (mime_type === 'image/svg+xml' || (!mime_type && /\.svg$/i.test(path ?? ''))) {
      const clean = sanitizeSvgMarkup(bytes.toString('utf8'));
      if (!clean) throw new Error('That is not an SVG image.');
      bytes = Buffer.from(clean, 'utf8');
      type = 'image/svg+xml';
    } else {
      const actual = sniffImage(bytes);
      if (!actual || (mime_type && actual !== mime_type)) throw new Error(`The bytes are ${actual ?? 'not a known image type'}${mime_type ? `, not ${mime_type}` : ''}.`);
      type = actual;
    }
    const asset = await ctx.app.storage.putAsset(bytes, type);
    return { src: asset.src, bytes: bytes.length, mime_type: type, usage: `<img src="${asset.src}" alt="..." style="width:100%;object-fit:cover">` };
  });

  define('agent_undo', { description: 'Take back your own last change in this file, or bring it back with redo true. One tool call or one batch is one step. Only your own changes are touched: what people and other agents did stays. If someone has since overwritten all of your last step, nothing is left of it to undo, so the step before it goes instead, and steps in the result tells you. Use it when a change turned out wrong; it is cheaper and safer than repairing by hand. The history lasts as long as the file stays loaded on the server; for an older change, or one from before a restart, use change_revert.', destructive: true }, {
    redo: z.boolean().default(false),
    file_id: fileIdArg,
  }, async ({ redo, file_id }, ctx) => {
    const room = await ctx.room(file_id);
    const before = room.undoDepth(ctx.agent);
    const changed = redo ? room.redoAgent(ctx.agent) : room.undoAgent(ctx.agent);
    const depth = room.undoDepth(ctx.agent);
    const steps = redo ? before.redo - depth.redo : before.undo - depth.undo;
    let note: string | undefined;
    if (!changed) note = redo ? 'Nothing to redo.' : 'None of your changes are left to undo in this file.';
    else if (steps > 1) note = `Someone had overwritten your more recent changes, so ${steps} steps were used up to find one that still had an effect. Check the result with layer_get.`;
    return { [redo ? 'redone' : 'undone']: changed, steps, can_undo: depth.undo, can_redo: depth.redo, ...(note ? { note } : {}) };
  });
}
